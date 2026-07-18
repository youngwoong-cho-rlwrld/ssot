import { makeId } from "../../../lib/id.ts";
import { FILTER_OPERATORS_BY_FIELD_TYPE } from "../../../lib/agentContract.mjs";
import type { Field } from "../../types/apiTypes.ts";
import type { RowType } from "../../types/layoutTypes.ts";
import {
  VALUELESS_FILTER_OPERATORS,
  type ColumnFilter,
  type FilterConjunction,
  type FilterNode,
  type FilterOperator,
  type FilterSource,
  type Filters,
  type NestedFilter,
} from "../../types/filterTypes.ts";

const VALUELESS_OPERATORS = new Set<FilterOperator>(VALUELESS_FILTER_OPERATORS);

type OperatorOption = { value: FilterOperator; label: string };

const OPERATORS_BY_FIELD_TYPE: Record<string, OperatorOption[]> = {
  TEXT: [
    { value: "CONTAINS", label: "Contains" },
    { value: "NOT_CONTAINS", label: "Does not contain" },
    { value: "EQUALS", label: "Exactly matches" },
    { value: "NOT_EQUALS", label: "Does not exactly match" },
    { value: "IN", label: "Is in" },
    { value: "NOT_IN", label: "Is not in" },
    { value: "STARTS_WITH", label: "Starts with" },
    { value: "NOT_STARTS_WITH", label: "Does not start with" },
    { value: "ENDS_WITH", label: "Ends with" },
    { value: "NOT_ENDS_WITH", label: "Does not end with" },
  ],
  NUMBER: [
    { value: "GT", label: "Greater than" },
    { value: "GTE", label: "Greater than or equal to" },
    { value: "LT", label: "Less than" },
    { value: "LTE", label: "Less than or equal to" },
    { value: "EQUALS", label: "Equal to" },
  ],
  DATETIME: [
    { value: "AFTER", label: "After" },
    { value: "AFTER_OR_ON", label: "After or including" },
    { value: "BEFORE", label: "Before" },
    { value: "BEFORE_OR_ON", label: "Before or including" },
    { value: "EQUALS", label: "Equals" },
  ],
  BOOLEAN: [
    { value: "IS_TRUE", label: "Is true" },
    { value: "IS_FALSE", label: "Is false" },
  ],
};

export function operatorsForField(field: Field | null): Array<{ value: FilterOperator; label: string }> {
  if (!field) return [];
  return OPERATORS_BY_FIELD_TYPE[field.type] ?? [];
}

export function isFilterOperatorValidForField(field: Field, operator: FilterOperator): boolean {
  return FILTER_OPERATORS_BY_FIELD_TYPE[field.type].some((candidate) => candidate === operator);
}

export function operatorRequiresValue(operator: FilterOperator | ""): boolean {
  return operator !== "" && !VALUELESS_OPERATORS.has(operator);
}

export function createEmptyColumnFilter(): ColumnFilter {
  return {
    id: makeId("filter"),
    columnId: "",
    operator: "",
    value: null,
  };
}

export function createEmptyFilters(): Filters {
  return {
    filters: {
      conjunction: "and",
      filterSet: [createEmptyColumnFilter()],
    },
  };
}

export function isNestedFilter(node: FilterNode | unknown): node is NestedFilter {
  return Boolean(
    node &&
      typeof node === "object" &&
      (node as { type?: unknown }).type === "nested" &&
      Array.isArray((node as { filterSet?: unknown }).filterSet),
  );
}

export function cloneFilters(filters: Filters): Filters {
  return {
    ...filters,
    filters: {
      ...filters.filters,
      filterSet: filters.filters.filterSet.map(cloneFilterNode),
    },
  };
}

function cloneFilterNode(node: FilterNode): FilterNode {
  if (!isNestedFilter(node)) return { ...node };
  return { ...node, filterSet: node.filterSet.map(cloneFilterNode) };
}

export function isEmptyFilter(filters: Filters | null | undefined): boolean {
  if (!filters) return true;
  return !filters.filters.filterSet.some(hasActiveFilter);
}

function hasActiveFilter(node: FilterNode): boolean {
  if (isNestedFilter(node)) return node.filterSet.some(hasActiveFilter);
  return Boolean(node.columnId && node.operator);
}

function createSearchFilter(columnId: string, searchValue: string): ColumnFilter {
  return {
    id: makeId("search"),
    columnId,
    operator: "CONTAINS",
    value: searchValue,
    source: "search",
  };
}

function createNestedSearchFilter(columnId: string, searchValue: string): NestedFilter {
  return {
    id: makeId("search-group"),
    type: "nested",
    conjunction: "or",
    source: "search",
    filterSet: [createSearchFilter(columnId, searchValue)],
  };
}

export function addSearchFilter(filters: Filters, columnId: string, searchValue: string): Filters {
  const value = searchValue.trim();
  if (!value) return filters;

  const root = filters.filters.filterSet.filter(hasActiveFilter).map(cloneFilterNode);
  const existingIndex = root.findIndex((node) => (
    isNestedFilter(node) &&
    node.source === "search" &&
    node.filterSet.every((child) => !isNestedFilter(child) && child.columnId === columnId)
  ));

  if (existingIndex >= 0) {
    const existing = root[existingIndex] as NestedFilter;
    const duplicate = existing.filterSet.some((node) => (
      !isNestedFilter(node) && String(node.value).toLowerCase() === value.toLowerCase()
    ));
    if (duplicate) return filters;
    root[existingIndex] = {
      ...existing,
      filterSet: [...existing.filterSet, createSearchFilter(columnId, value)],
    };
  } else {
    root.push(createNestedSearchFilter(columnId, value));
  }

  return {
    filters: { ...filters.filters, filterSet: root },
    source: "search",
  };
}

export function removeSearchFiltersForColumn(filters: Filters, columnId: string): Filters {
  const filterSet = filters.filters.filterSet.flatMap((node): FilterNode[] => {
    if (isNestedFilter(node)) {
      const children = node.filterSet.filter((child) => (
        isNestedFilter(child) || child.source !== "search" || child.columnId !== columnId
      ));
      if (!children.length && node.source === "search") return [];
      return [{ ...node, filterSet: children }];
    }
    return node.source === "search" && node.columnId === columnId ? [] : [node];
  });
  return withEditableRoot({ ...filters, filters: { ...filters.filters, filterSet } });
}

export function keepOnlyFilterSource(filters: Filters, source: FilterSource): Filters {
  const filterSet = collectNodesForSource(filters.filters.filterSet, source);
  return withEditableRoot({
    filters: { conjunction: filters.filters.conjunction, filterSet },
    source: filterSet.length ? source : undefined,
  });
}

export function removeFilterSource(filters: Filters, source: FilterSource): Filters {
  const filterSet = removeNodesForSource(filters.filters.filterSet, source);
  return withEditableRoot({
    ...filters,
    filters: { ...filters.filters, filterSet },
  });
}

function removeNodesForSource(nodes: FilterNode[], source: FilterSource): FilterNode[] {
  return nodes.flatMap((node): FilterNode[] => {
    if (!isNestedFilter(node)) return node.source === source ? [] : [{ ...node }];
    const children = removeNodesForSource(node.filterSet, source);
    if (!children.length && node.source === source) return [];
    return children.length ? [{ ...node, filterSet: children }] : [];
  });
}

function collectNodesForSource(nodes: FilterNode[], source: FilterSource): FilterNode[] {
  return nodes.flatMap((node): FilterNode[] => {
    if (!isNestedFilter(node)) return node.source === source ? [{ ...node }] : [];
    const children = collectNodesForSource(node.filterSet, source);
    if (!children.length) return [];
    return [{ ...node, filterSet: children }];
  });
}

export function mergeFilterSources(searchFilters: Filters, advancedFilters: Filters): Filters {
  const searchNodes = collectNodesForSource(searchFilters.filters.filterSet, "search");
  const advancedNodes = advancedFilters.filters.filterSet
    .filter(hasActiveFilter)
    .map((node) => markFilterSource(node, "advanced-filter"));
  return withEditableRoot({
    filters: {
      conjunction: advancedFilters.filters.conjunction,
      filterSet: [...searchNodes, ...advancedNodes],
    },
    source: searchNodes.length && !advancedNodes.length ? "search" : "advanced-filter",
  });
}

export function finalizeEditedFilters(filters: Filters): Filters {
  const filterSet = filters.filters.filterSet.filter(hasActiveFilter).map(cloneFilterNode);
  const { hasAdvancedFilter, searchFilters } = separateFilters({
    ...filters,
    filters: { ...filters.filters, filterSet },
  });
  return withEditableRoot({
    filters: { conjunction: filters.filters.conjunction, filterSet },
    source: hasAdvancedFilter ? "advanced-filter" : searchFilters.length ? "search" : undefined,
  });
}

function markFilterSource(node: FilterNode, source: FilterSource): FilterNode {
  if (!isNestedFilter(node)) return { ...node, source };
  return { ...node, source, filterSet: node.filterSet.map((child) => markFilterSource(child, source)) };
}

function withEditableRoot(filters: Filters): Filters {
  if (filters.filters.filterSet.length) return filters;
  return {
    ...filters,
    source: undefined,
    filters: { ...filters.filters, filterSet: [createEmptyColumnFilter()] },
  };
}

export function isValidFilter(filters: Filters | null | undefined): boolean {
  if (!filters?.filters.filterSet.length) return false;
  return filters.filters.filterSet.every(isValidFilterNode);
}

function isValidFilterNode(node: FilterNode): boolean {
  if (isNestedFilter(node)) return node.filterSet.length > 0 && node.filterSet.every(isValidFilterNode);
  if (!node.columnId || !node.operator) return false;
  return !operatorRequiresValue(node.operator) || !isBlankFilterValue(node.value);
}

export function isBlankFilterValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);
}

export function separateFilters(
  filters: Filters | null | undefined,
): { hasAdvancedFilter: boolean; searchFilters: ColumnFilter[] } {
  const out = { hasAdvancedFilter: false, searchFilters: [] as ColumnFilter[] };
  for (const node of filters?.filters.filterSet ?? []) collectSeparatedFilters(node, out);
  return out;
}

function collectSeparatedFilters(
  node: FilterNode,
  out: { hasAdvancedFilter: boolean; searchFilters: ColumnFilter[] },
) {
  if (isNestedFilter(node)) {
    for (const child of node.filterSet) collectSeparatedFilters(child, out);
    return;
  }
  if (!node.columnId || !node.operator) return;
  if (node.source === "search") out.searchFilters.push(node);
  else out.hasAdvancedFilter = true;
}

export function extractConjunctionsFromFilters(
  filters: Filters | null | undefined,
): Array<ColumnFilter & { _nestedParentConjunction?: FilterConjunction }> {
  const out: Array<ColumnFilter & { _nestedParentConjunction?: FilterConjunction }> = [];
  for (const node of filters?.filters.filterSet ?? []) {
    flattenFilters(node, filters?.filters.conjunction ?? "and", out);
  }
  return out;
}

function flattenFilters(
  node: FilterNode,
  conjunction: FilterConjunction,
  out: Array<ColumnFilter & { _nestedParentConjunction?: FilterConjunction }>,
) {
  if (isNestedFilter(node)) {
    for (const child of node.filterSet) flattenFilters(child, node.conjunction, out);
    return;
  }
  out.push({ ...node, _nestedParentConjunction: conjunction });
}

export function filterColumnIds(filters: Filters | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const node of filters?.filters.filterSet ?? []) collectColumnIds(node, ids);
  return ids;
}

function collectColumnIds(node: FilterNode, ids: Set<string>) {
  if (isNestedFilter(node)) {
    node.filterSet.forEach((child) => collectColumnIds(child, ids));
  } else if (node.columnId) {
    ids.add(node.columnId);
  }
}

export function rowMatchesFilters(row: RowType, filters: Filters | null | undefined): boolean {
  if (!filters || isEmptyFilter(filters)) return true;
  return matchesFilterSet(row, filters.filters.filterSet, filters.filters.conjunction);
}

function matchesFilterSet(
  row: RowType,
  filterSet: FilterNode[],
  conjunction: FilterConjunction,
): boolean {
  const active = filterSet.filter(hasActiveFilter);
  if (!active.length) return true;
  const results = active.map((node) => rowMatchesFilterNode(row, node));
  return conjunction === "or" ? results.some(Boolean) : results.every(Boolean);
}

function rowMatchesFilterNode(row: RowType, node: FilterNode): boolean {
  if (isNestedFilter(node)) return matchesFilterSet(row, node.filterSet, node.conjunction);
  return valueMatchesFilter(row[node.columnId], node);
}

export function valueMatchesFilter(cellValue: unknown, filter: ColumnFilter): boolean {
  const filterValue = filter.value;
  const cellText = String(cellValue ?? "").toLowerCase();
  const filterText = String(filterValue ?? "").toLowerCase();

  switch (filter.operator) {
    case "EXISTS":
      return !isBlankFilterValue(cellValue);
    case "NOT_EXISTS":
      return isBlankFilterValue(cellValue);
    case "IS_TRUE":
      return cellValue === true || cellText === "true";
    case "IS_FALSE":
      return cellValue === false || cellText === "false";
    case "EQUALS":
      return isDateLike(filterValue) ? sameDateValue(cellValue, filterValue) : cellText === filterText;
    case "NOT_EQUALS":
      return isDateLike(filterValue) ? !sameDateValue(cellValue, filterValue) : cellText !== filterText;
    case "CONTAINS":
      return cellText.includes(filterText);
    case "NOT_CONTAINS":
      return !cellText.includes(filterText);
    case "STARTS_WITH":
      return cellText.startsWith(filterText);
    case "NOT_STARTS_WITH":
      return !cellText.startsWith(filterText);
    case "ENDS_WITH":
      return cellText.endsWith(filterText);
    case "NOT_ENDS_WITH":
      return !cellText.endsWith(filterText);
    case "IN":
      return listValues(filterValue).includes(cellText);
    case "NOT_IN":
      return !listValues(filterValue).includes(cellText);
    case "GT":
      return numericValue(cellValue) > numericValue(filterValue);
    case "GTE":
      return numericValue(cellValue) >= numericValue(filterValue);
    case "LT":
      return numericValue(cellValue) < numericValue(filterValue);
    case "LTE":
      return numericValue(cellValue) <= numericValue(filterValue);
    case "AFTER":
      return dateValue(cellValue) > dateValue(filterValue);
    case "AFTER_OR_ON":
      return dateValue(cellValue) >= dateValue(filterValue);
    case "BEFORE":
      return dateValue(cellValue) < dateValue(filterValue);
    case "BEFORE_OR_ON":
      return dateValue(cellValue) <= dateValue(filterValue);
    case "":
      return false;
  }
}

function listValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return values.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

function numericValue(value: unknown): number {
  if (typeof value === "number") return value;
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function dateValue(value: unknown): number {
  const time = parseDateTime(value);
  return Number.isFinite(time) ? time : Number.NaN;
}

function sameDateValue(left: unknown, right: unknown): boolean {
  const leftTime = parseDateTime(left);
  const rightTime = parseDateTime(right);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return false;
  const leftDate = new Date(leftTime);
  const rightDate = new Date(rightTime);
  return leftDate.getFullYear() === rightDate.getFullYear() &&
    leftDate.getMonth() === rightDate.getMonth() &&
    leftDate.getDate() === rightDate.getDate();
}

function isDateLike(value: unknown): boolean {
  return value instanceof Date || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value));
}

function parseDateTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const raw = String(value ?? "").trim();
  if (!raw) return Number.NaN;

  const compact = raw.match(/^(\d{2})(\d{2})(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (compact) {
    return new Date(
      Number(compact[3]),
      Number(compact[1]) - 1,
      Number(compact[2]),
      compact[4] ? Number(compact[4]) : 0,
      compact[5] ? Number(compact[5]) : 0,
    ).getTime();
  }

  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (slash) {
    return new Date(
      Number(slash[3]),
      Number(slash[1]) - 1,
      Number(slash[2]),
      slash[4] ? Number(slash[4]) : 0,
      slash[5] ? Number(slash[5]) : 0,
    ).getTime();
  }

  if (/^\d+$/.test(raw) || /^[\d/]+$/.test(raw)) return Number.NaN;
  return new Date(raw).getTime();
}
