// Serialize the shareable view state to/from the URL query string so a link
// reproduces the current view. URL state is untrusted input: keep this module
// as the runtime boundary and only return values the rest of the app can use.

import {
  FILTER_OPERATORS,
  VALUELESS_FILTER_OPERATORS,
  type FilterOperator,
  type FilterSource,
  type Filters,
  type ColumnFilter,
  type FilterNode,
  type FilterGroup,
  type NestedFilter,
} from "../enmight/types/filterTypes.ts";
import type {
  ColorStylerItemType,
  SortByItemType,
} from "../enmight/types/layoutTypes.ts";
import type { Field } from "../enmight/types/apiTypes.ts";
import {
  DEFAULT_CHART_GROUP_MODE,
  DEFAULT_CHART_TYPE,
  isChartGroupMode,
  isChartType,
  isTaskChartGroupMode,
  type ChartGroupMode,
  type ChartGroupOverrides,
  type ChartType,
} from "./chartTypes.ts";
import { normalizeTableColor } from "./tableColors.ts";
import {
  createEmptyFilters,
  isBlankFilterValue,
  isFilterOperatorValidForField,
  isNestedFilter,
} from "../enmight/utils/tables/filters.ts";

export type ViewState = {
  sort: SortByItemType[];
  filters: Filters;
  colors: ColorStylerItemType[];
  // null = default (all columns visible); an array = explicit visible set.
  visibleColumnIds: string[] | null;
  chartOpen: boolean;
  chartType: ChartType;
  chartGroupBy: ChartGroupMode;
  // taskKey -> effective grouping for that task chart; absent = follow chartGroupBy.
  chartGroupOverrides: ChartGroupOverrides;
  chatOpen: boolean;
};

// Only the fields present and valid in the URL are returned, so callers apply
// a partial overlay onto their defaults.
type DecodedViewState = Partial<ViewState>;

export const VIEW_STATE_LIMITS = Object.freeze({
  sortItems: 12,
  filterNodes: 64,
  filterDepth: 4,
  colorItems: 24,
  chartGroupOverrides: 64,
  visibleColumns: 256,
  identifierLength: 256,
  stringLength: 2_048,
  valueItems: 50,
  valueProperties: 24,
  valueDepth: 3,
  scalarLength: 16,
  parameterLength: 32_768,
});

const INVALID_VALUE = Symbol("invalid view-state value");
const FILTER_OPERATOR_SET = new Set<FilterOperator>(FILTER_OPERATORS);
const VALUELESS_FILTER_OPERATOR_SET = new Set<FilterOperator>(VALUELESS_FILTER_OPERATORS);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type FilterBudget = {
  remainingNodes: number;
  ids: Set<string>;
};

export function encodeViewState(state: ViewState): string {
  const params = new URLSearchParams();

  const sort = normalizeSortItems(state.sort);
  if (sort.length) setJsonParameter(params, "sort", sort);

  const filters = normalizeFilters(state.filters);
  if (filters) setJsonParameter(params, "filters", filters);

  const colors = normalizeColorItems(state.colors);
  if (colors.length) setJsonParameter(params, "colors", colors);

  if (state.visibleColumnIds !== null) {
    const columns = normalizeColumnIds(state.visibleColumnIds);
    const encodedColumns = fitJoinedParameter(columns);
    if (encodedColumns.length) params.set("cols", encodedColumns.join(","));
  }

  // Panel visibility and the selected type are independent. In particular, a
  // non-default type remains shareable after the chart panel is closed.
  if (state.chartOpen === true) params.set("chart", "1");
  if (isViewChartType(state.chartType) && state.chartType !== DEFAULT_CHART_TYPE) {
    params.set("chartType", state.chartType);
  }
  if (isViewChartGroupMode(state.chartGroupBy) && state.chartGroupBy !== DEFAULT_CHART_GROUP_MODE) {
    params.set("chartGroupBy", state.chartGroupBy);
  }
  const chartGroupOverrides = normalizeChartGroupOverrides(state.chartGroupOverrides);
  if (Object.keys(chartGroupOverrides).length) {
    setJsonParameter(params, "chartGroups", chartGroupOverrides);
  }
  if (state.chatOpen === true) params.set("chat", "1");

  return params.toString();
}

export function decodeViewState(search: string): DecodedViewState {
  const params = new URLSearchParams(search);
  const out: DecodedViewState = {};

  const sort = normalizeSortItems(safeParseJson(params.get("sort")));
  if (sort.length) out.sort = sort;

  const filters = normalizeFilters(safeParseJson(params.get("filters")));
  if (filters) out.filters = filters;

  const colors = normalizeColorItems(safeParseJson(params.get("colors")));
  if (colors.length) out.colors = colors;

  const columnsParameter = boundedParameter(params.get("cols"));
  if (columnsParameter) {
    const columns = normalizeColumnIds(columnsParameter.split(","));
    if (columns.length) out.visibleColumnIds = columns;
  }

  if (boundedScalarParameter(params.get("chart")) === "1") out.chartOpen = true;

  const chartType = boundedScalarParameter(params.get("chartType"));
  if (isViewChartType(chartType)) out.chartType = chartType;

  const chartGroupBy = boundedScalarParameter(params.get("chartGroupBy"));
  if (isViewChartGroupMode(chartGroupBy)) out.chartGroupBy = chartGroupBy;

  const chartGroupOverrides = normalizeChartGroupOverrides(safeParseJson(params.get("chartGroups")));
  if (Object.keys(chartGroupOverrides).length) out.chartGroupOverrides = chartGroupOverrides;

  if (boundedScalarParameter(params.get("chat")) === "1") out.chatOpen = true;

  return out;
}

export function reconcileViewStateColumns(
  state: ViewState,
  availableColumns: Field[],
): ViewState {
  const availableById = new Map(availableColumns.map((column) => [column.id, column]));
  const columnIds = normalizeColumnIds([...availableById.keys()]);
  if (!columnIds.length) return state;
  const columnsById = new Map(columnIds.map((columnId) => [columnId, availableById.get(columnId)!]));
  const validColumns = new Set(columnIds);
  const filters = pruneFiltersToColumns(state.filters, columnsById) ?? createEmptyFilters();
  const colors = state.colors.flatMap((item): ColorStylerItemType[] => {
    const filter = pruneFiltersToColumns(item.filter, columnsById);
    return filter ? [{ ...item, filter }] : [];
  });
  const visibleColumnIds = state.visibleColumnIds === null
    ? null
    : canonicalVisibleColumns(
        state.visibleColumnIds.filter((columnId) => validColumns.has(columnId)),
        columnIds,
      );
  const taskKeys = taskKeysFromColumnIds(columnIds);
  const chartGroupOverrides = Object.fromEntries(
    Object.entries(state.chartGroupOverrides).filter(([taskKey]) => taskKeys.has(taskKey)),
  );

  return {
    ...state,
    sort: state.sort.filter((item) => Boolean(item.fieldId && validColumns.has(item.fieldId))),
    filters,
    colors,
    visibleColumnIds,
    chartGroupOverrides,
  };
}

// Metric column ids are `${taskKey}::${evalSet}` (results.ts performanceCellId).
export function taskKeysFromColumnIds(columnIds: Iterable<string>): Set<string> {
  const taskKeys = new Set<string>();
  for (const columnId of columnIds) {
    const separator = columnId.indexOf("::");
    if (separator > 0) taskKeys.add(columnId.slice(0, separator));
  }
  return taskKeys;
}

function pruneFiltersToColumns(filters: Filters, columnsById: ReadonlyMap<string, Field>): Filters | null {
  const filterSet = filters.filters.filterSet
    .map((node) => pruneFilterNodeToColumns(node, columnsById))
    .filter((node): node is FilterNode => node !== null);
  if (!filterSet.length) return null;
  return {
    ...filters,
    filters: { ...filters.filters, filterSet },
  };
}

function pruneFilterNodeToColumns(
  node: FilterNode,
  columnsById: ReadonlyMap<string, Field>,
): FilterNode | null {
  if (!isNestedFilter(node)) {
    const field = columnsById.get(node.columnId);
    return field && node.operator && isFilterOperatorValidForField(field, node.operator)
      ? node
      : null;
  }
  const filterSet = node.filterSet
    .map((child) => pruneFilterNodeToColumns(child, columnsById))
    .filter((child): child is FilterNode => child !== null);
  return filterSet.length ? { ...node, filterSet } : null;
}

function canonicalVisibleColumns(columnIds: string[], allColumnIds: string[]) {
  if (!columnIds.length || columnIds.length === allColumnIds.length) return null;
  return columnIds;
}

function normalizeSortItems(value: unknown): SortByItemType[] {
  if (!Array.isArray(value)) return [];

  const items: SortByItemType[] = [];
  const ids = new Set<string>();
  const fields = new Set<string>();
  for (const input of value) {
    if (items.length >= VIEW_STATE_LIMITS.sortItems) break;
    if (!isPlainRecord(input)) continue;

    const id = normalizeIdentifier(input.id);
    const fieldId = normalizeIdentifier(input.fieldId);
    const sortState = input.sortState;
    if (!id || !fieldId || (sortState !== "asc" && sortState !== "desc")) continue;
    if (ids.has(id) || fields.has(fieldId)) continue;

    ids.add(id);
    fields.add(fieldId);
    items.push({ id, fieldId, sortState });
  }
  return items;
}

function normalizeFilters(value: unknown): Filters | null {
  if (!isPlainRecord(value)) return null;

  const rootInput = isPlainRecord(value.filters) ? value.filters : null;
  if (!rootInput) return null;

  const budget: FilterBudget = {
    remainingNodes: VIEW_STATE_LIMITS.filterNodes,
    ids: new Set(),
  };
  const filters = normalizeRootFilterGroup(rootInput, budget);
  if (!filters) return null;

  const normalized: Filters = { filters };
  const source = normalizeFilterSource(value.source);
  if (source) normalized.source = source;
  return normalized;
}

function normalizeRootFilterGroup(
  value: Record<string, unknown>,
  budget: FilterBudget,
): FilterGroup | null {
  if (!Array.isArray(value.filterSet)) return null;
  const filterSet: Array<ColumnFilter | NestedFilter> = [];
  for (const child of value.filterSet) {
    const normalized = normalizeFilterNode(child, budget, 0);
    if (normalized) filterSet.push(normalized);
    if (budget.remainingNodes <= 0) break;
  }
  if (!filterSet.length) return null;
  return {
    conjunction: value.conjunction === "or" ? "or" : "and",
    filterSet,
  };
}

function normalizeFilterNode(
  value: unknown,
  budget: FilterBudget,
  parentDepth: number,
): ColumnFilter | NestedFilter | null {
  if (budget.remainingNodes <= 0 || !isPlainRecord(value)) return null;
  budget.remainingNodes -= 1;

  if (value.type === "nested" || Array.isArray(value.filterSet)) {
    return normalizeNestedFilter(value, budget, parentDepth + 1);
  }

  const id = normalizeIdentifier(value.id);
  const columnId = normalizeIdentifier(value.columnId);
  const operator = typeof value.operator === "string" ? value.operator : "";
  if (
    !id ||
    budget.ids.has(id) ||
    !columnId ||
    !FILTER_OPERATOR_SET.has(operator as FilterOperator)
  ) {
    return null;
  }

  const hasValue = Object.prototype.hasOwnProperty.call(value, "value");
  const normalizedValue = hasValue ? normalizeJsonValue(value.value, 0) : INVALID_VALUE;
  if (!VALUELESS_FILTER_OPERATOR_SET.has(operator as FilterOperator)) {
    if (normalizedValue === INVALID_VALUE || isBlankFilterValue(normalizedValue)) return null;
  } else if (hasValue && normalizedValue === INVALID_VALUE) {
    return null;
  }

  budget.ids.add(id);
  const condition: ColumnFilter = {
    id,
    columnId,
    operator: operator as FilterOperator,
    value: hasValue && normalizedValue !== INVALID_VALUE ? normalizedValue : null,
  };
  const source = normalizeFilterSource(value.source);
  if (source) condition.source = source;
  return condition;
}

function normalizeNestedFilter(
  value: Record<string, unknown>,
  budget: FilterBudget,
  depth: number,
): NestedFilter | null {
  if (depth > VIEW_STATE_LIMITS.filterDepth || !Array.isArray(value.filterSet)) return null;

  const id = normalizeIdentifier(value.id);
  if (!id || budget.ids.has(id)) return null;
  budget.ids.add(id);

  const filterSet: Array<ColumnFilter | NestedFilter> = [];
  for (const child of value.filterSet) {
    const normalized = normalizeFilterNode(child, budget, depth);
    if (normalized) filterSet.push(normalized);
    if (budget.remainingNodes <= 0) break;
  }
  if (!filterSet.length) return null;

  const nested: NestedFilter = {
    id,
    type: "nested",
    conjunction: value.conjunction === "or" ? "or" : "and",
    filterSet,
  };
  const source = normalizeFilterSource(value.source);
  if (source) nested.source = source;
  return nested;
}

function normalizeColorItems(value: unknown): ColorStylerItemType[] {
  if (!Array.isArray(value)) return [];

  const items: ColorStylerItemType[] = [];
  const ids = new Set<string>();
  for (const input of value) {
    if (items.length >= VIEW_STATE_LIMITS.colorItems) break;
    if (!isPlainRecord(input)) continue;

    const id = normalizeIdentifier(input.id);
    const color = normalizeColor(input.color);
    const targetType = input.targetType;
    const filter = normalizeFilters(input.filter);
    if (!id || ids.has(id) || !color || !filter) continue;
    if (targetType !== "cell" && targetType !== "row") continue;

    ids.add(id);
    items.push({ id, color, targetType, filter });
  }
  return items;
}

function normalizeColumnIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const input of value) {
    if (columns.length >= VIEW_STATE_LIMITS.visibleColumns) break;
    const columnId = normalizeIdentifier(input);
    if (!columnId || seen.has(columnId)) continue;
    seen.add(columnId);
    columns.push(columnId);
  }
  return columns;
}

function normalizeJsonValue(value: unknown, depth: number): unknown | typeof INVALID_VALUE {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID_VALUE;
  if (typeof value === "string") {
    return value.length <= VIEW_STATE_LIMITS.stringLength ? value : INVALID_VALUE;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : INVALID_VALUE;
  }
  if (depth >= VIEW_STATE_LIMITS.valueDepth) return INVALID_VALUE;

  if (Array.isArray(value)) {
    if (value.length > VIEW_STATE_LIMITS.valueItems) return INVALID_VALUE;
    const items: unknown[] = [];
    for (const item of value) {
      const normalized = normalizeJsonValue(item, depth + 1);
      if (normalized === INVALID_VALUE) return INVALID_VALUE;
      items.push(normalized);
    }
    return items;
  }

  if (!isPlainRecord(value)) return INVALID_VALUE;
  const entries = Object.entries(value);
  if (entries.length > VIEW_STATE_LIMITS.valueProperties) return INVALID_VALUE;
  const record: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (
      !key ||
      key.length > VIEW_STATE_LIMITS.identifierLength ||
      UNSAFE_OBJECT_KEYS.has(key) ||
      hasControlCharacters(key)
    ) {
      return INVALID_VALUE;
    }
    const normalized = normalizeJsonValue(item, depth + 1);
    if (normalized === INVALID_VALUE) return INVALID_VALUE;
    record[key] = normalized;
  }
  return record;
}

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > VIEW_STATE_LIMITS.identifierLength ||
    normalized.includes(",") ||
    hasControlCharacters(normalized) ||
    !/^[a-z0-9][a-z0-9_.:-]*$/i.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeFilterSource(value: unknown): FilterSource | null {
  return value === "advanced-filter" || value === "agent" || value === "search"
    ? value
    : null;
}

function isViewChartType(value: unknown): value is ChartType {
  return typeof value === "string" && isChartType(value);
}

function isViewChartGroupMode(value: unknown): value is ChartGroupMode {
  return typeof value === "string" && isChartGroupMode(value);
}

function normalizeChartGroupOverrides(value: unknown): ChartGroupOverrides {
  if (!isPlainRecord(value)) return {};

  const overrides: ChartGroupOverrides = {};
  for (const [key, mode] of Object.entries(value)) {
    if (Object.keys(overrides).length >= VIEW_STATE_LIMITS.chartGroupOverrides) break;
    const taskKey = normalizeIdentifier(key);
    if (!taskKey || typeof mode !== "string" || !isTaskChartGroupMode(mode)) continue;
    overrides[taskKey] = mode;
  }
  return overrides;
}

function normalizeColor(value: unknown): string | null {
  return normalizeTableColor(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacters(value: string) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function safeParseJson(value: string | null): unknown {
  const bounded = boundedParameter(value);
  if (!bounded) return null;
  try {
    return JSON.parse(bounded) as unknown;
  } catch {
    return null;
  }
}

function boundedParameter(value: string | null): string | null {
  if (value === null || value.length > VIEW_STATE_LIMITS.parameterLength) return null;
  return value;
}

function boundedScalarParameter(value: string | null): string | null {
  if (value === null || value.length > VIEW_STATE_LIMITS.scalarLength) return null;
  return value;
}

function setJsonParameter(params: URLSearchParams, key: string, value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= VIEW_STATE_LIMITS.parameterLength) params.set(key, serialized);
}

function fitJoinedParameter(columnIds: string[]) {
  const fitted = [...columnIds];
  while (fitted.length && fitted.join(",").length > VIEW_STATE_LIMITS.parameterLength) fitted.pop();
  return fitted;
}
