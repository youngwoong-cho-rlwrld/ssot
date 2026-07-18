import {
  AGENT_ACTION_NAMES,
  AGENT_ACTIONS,
  MAX_AGENT_ACTIONS,
  VALUELESS_FILTER_OPERATORS,
} from "./agentContract.mjs";
import {
  isChartGroupMode,
  isChartType,
  isTaskChartGroupMode,
  type ChartGroupMode,
  type ChartType,
  type TaskChartGroupMode,
} from "./chartTypes.ts";
import { taskKeysFromColumnIds } from "./viewState.ts";
import { makeId } from "./id.ts";
import { normalizeTableColor } from "./tableColors.ts";
import type { Field } from "../enmight/types/apiTypes.ts";
import { FILTER_OPERATORS, type Filters } from "../enmight/types/filterTypes.ts";
import type { ColorStylerItemType, SortByItemType } from "../enmight/types/layoutTypes.ts";
import {
  createEmptyFilters,
  isBlankFilterValue,
  isFilterOperatorValidForField,
} from "../enmight/utils/tables/filters.ts";

type AgentSortItemInput = {
  fieldId?: unknown;
  sortState?: unknown;
};

type AgentConditionInput = {
  columnId?: unknown;
  operator?: unknown;
  value?: unknown;
};

type AgentColorRuleInput = AgentConditionInput & {
  color?: unknown;
  targetType?: unknown;
};

export { AGENT_ACTION_NAMES, AGENT_ACTIONS };

type AgentActionName = (typeof AGENT_ACTION_NAMES)[number];

type EmptyAgentActionPayload = Record<never, never>;

type AgentActionPayloadByName = {
  [AGENT_ACTIONS.SET_SORT]: { items: Array<{ fieldId: string; sortState: "asc" | "desc" }> };
  [AGENT_ACTIONS.CLEAR_SORT]: EmptyAgentActionPayload;
  [AGENT_ACTIONS.SET_FILTERS]: { conjunction: "and" | "or"; conditions: AgentFilterCondition[] };
  [AGENT_ACTIONS.CLEAR_FILTERS]: EmptyAgentActionPayload;
  [AGENT_ACTIONS.SHOW_COLUMNS]: { columnIds: string[] };
  [AGENT_ACTIONS.HIDE_COLUMNS]: { columnIds: string[] };
  [AGENT_ACTIONS.SET_VISIBLE_COLUMNS]: { columnIds: string[] };
  [AGENT_ACTIONS.SET_COLOR_RULES]: { rules: AgentColorRule[] };
  [AGENT_ACTIONS.CLEAR_COLORS]: EmptyAgentActionPayload;
  [AGENT_ACTIONS.REFRESH]: EmptyAgentActionPayload;
  [AGENT_ACTIONS.SET_CHART_OPEN]: { open: boolean };
  [AGENT_ACTIONS.SET_CHART_TYPE]: { chartType: ChartType };
  [AGENT_ACTIONS.SET_CHART_GROUPING]: {
    groupBy: ChartGroupMode;
    taskOverrides: AgentChartGroupOverride[];
  };
};

export type AgentChartGroupOverride = {
  taskKey: string;
  groupBy: TaskChartGroupMode;
};

export type AgentAction = {
  [Name in AgentActionName]: { type: Name } & AgentActionPayloadByName[Name];
}[AgentActionName];

type AgentFilterCondition = {
  columnId: string;
  operator: AgentFilterOperator;
  value?: unknown;
};

type AgentColorRule = AgentFilterCondition & {
  color: string;
  targetType: "row" | "cell";
};

type AgentEnvelope = {
  message: string;
  actions: AgentAction[];
};

type AgentValidationResult = {
  envelope: AgentEnvelope | null;
  errors: string[];
};

const AGENT_FILTER_OPERATORS = FILTER_OPERATORS;

type AgentFilterOperator = (typeof AGENT_FILTER_OPERATORS)[number];

const OPERATOR_SET = new Set<string>(AGENT_FILTER_OPERATORS);
const ACTION_NAME_SET = new Set<string>(AGENT_ACTION_NAMES);
const VALUELESS_OPERATORS = new Set<AgentFilterOperator>(VALUELESS_FILTER_OPERATORS);

export function validateAgentEnvelope(input: unknown, columns: Field[]): AgentValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { envelope: null, errors: ["response must be a JSON object"] };
  }

  const record = input as Record<string, unknown>;
  if (typeof record.message !== "string") {
    errors.push("response.message must be a string");
  }
  if (!Array.isArray(record.actions)) {
    errors.push("response.actions must be an array");
  } else if (record.actions.length > MAX_AGENT_ACTIONS) {
    errors.push(`response.actions must contain at most ${MAX_AGENT_ACTIONS} actions`);
  }
  if (errors.length) return { envelope: null, errors };

  const actionsInput = record.actions as unknown[];
  const actions: AgentAction[] = [];

  for (const actionInput of actionsInput) {
    const action = validateAction(actionInput, columns, errors);
    if (action) actions.push(action);
  }

  if (errors.length) {
    return { envelope: null, errors };
  }

  return {
    envelope: {
      message: record.message as string,
      actions,
    },
    errors: [],
  };
}

export function createSortByItems(items: Array<{ fieldId: string; sortState: "asc" | "desc" }>): SortByItemType[] {
  return items.map((item) => ({
    id: makeId("agent"),
    fieldId: item.fieldId,
    sortState: item.sortState,
  }));
}

export function createFiltersFromConditions(
  conditions: AgentFilterCondition[],
  conjunction: "and" | "or" = "and",
): Filters {
  return {
    filters: {
      conjunction,
      filterSet: conditions.map((condition) => ({
        id: makeId("agent"),
        columnId: condition.columnId,
        operator: condition.operator,
        value: condition.value ?? null,
        source: "agent",
      })),
    },
    source: "agent",
  };
}

export function createColorRulesFromAgentRules(rules: AgentColorRule[]): ColorStylerItemType[] {
  return rules.map((rule) => ({
    id: makeId("agent"),
    color: rule.color,
    targetType: rule.targetType,
    filter: createFiltersFromConditions([rule], "and"),
  }));
}

export function emptyAgentFilters(): Filters {
  return createEmptyFilters();
}

export function agentColumnContext(columns: Field[]) {
  return columns.map((column) => ({
    id: column.id,
    label: column.displayName,
    type: column.type,
  }));
}

function validateAction(input: unknown, columns: Field[], errors: string[]): AgentAction | null {
  if (!input || typeof input !== "object") {
    errors.push("each action must be an object");
    return null;
  }

  const record = input as Record<string, unknown>;
  const actionType = record.type;
  if (typeof actionType !== "string") {
    errors.push("action type must be a string");
    return null;
  }
  if (!ACTION_NAME_SET.has(actionType)) {
    errors.push(`unsupported action type: ${actionType}`);
    return null;
  }

  const type = actionType as AgentActionName;

  switch (type) {
    case AGENT_ACTIONS.SET_SORT: {
      if (!Array.isArray(record.items) || !record.items.length) {
        errors.push(`${AGENT_ACTIONS.SET_SORT}.items must be a non-empty array; use ${AGENT_ACTIONS.CLEAR_SORT} to clear it`);
        return null;
      }
      const itemsInput = record.items;
      const items = itemsInput
        .map((item) => validateSortItem(item, columns, errors))
        .filter((item): item is { fieldId: string; sortState: "asc" | "desc" } => Boolean(item));
      if (new Set(items.map((item) => item.fieldId)).size !== items.length) {
        errors.push(`${AGENT_ACTIONS.SET_SORT}.items must not contain duplicate fields`);
        return null;
      }
      return { type, items };
    }
    case AGENT_ACTIONS.CLEAR_SORT:
      return { type };
    case AGENT_ACTIONS.SET_FILTERS: {
      if (!Array.isArray(record.conditions) || !record.conditions.length) {
        errors.push(`${AGENT_ACTIONS.SET_FILTERS}.conditions must be a non-empty array; use ${AGENT_ACTIONS.CLEAR_FILTERS} to clear it`);
        return null;
      }
      if (record.conjunction !== "and" && record.conjunction !== "or") {
        errors.push(`${AGENT_ACTIONS.SET_FILTERS}.conjunction must be and or or`);
        return null;
      }
      const conditionsInput = record.conditions;
      const conditions = conditionsInput
        .map((condition) => validateCondition(condition, columns, errors))
        .filter((condition): condition is AgentFilterCondition => Boolean(condition));
      const conjunction = record.conjunction;
      return { type, conjunction, conditions };
    }
    case AGENT_ACTIONS.CLEAR_FILTERS:
      return { type };
    case AGENT_ACTIONS.SHOW_COLUMNS:
    case AGENT_ACTIONS.HIDE_COLUMNS:
    case AGENT_ACTIONS.SET_VISIBLE_COLUMNS: {
      if (!Array.isArray(record.columnIds) || !record.columnIds.length) {
        errors.push(`${type}.columnIds must be a non-empty array`);
        return null;
      }
      const columnIdsInput = record.columnIds;
      const columnIds = normalizeColumnIds(columnIdsInput, columns, errors);
      return { type, columnIds };
    }
    case AGENT_ACTIONS.SET_COLOR_RULES: {
      if (!Array.isArray(record.rules) || !record.rules.length) {
        errors.push(`${AGENT_ACTIONS.SET_COLOR_RULES}.rules must be a non-empty array; use ${AGENT_ACTIONS.CLEAR_COLORS} to clear it`);
        return null;
      }
      const rulesInput = record.rules;
      const rules = rulesInput
        .map((rule) => validateColorRule(rule, columns, errors))
        .filter((rule): rule is AgentColorRule => Boolean(rule));
      return { type, rules };
    }
    case AGENT_ACTIONS.CLEAR_COLORS:
      return { type };
    case AGENT_ACTIONS.REFRESH:
      return { type };
    case AGENT_ACTIONS.SET_CHART_OPEN:
      if (typeof record.open !== "boolean") {
        errors.push(`${AGENT_ACTIONS.SET_CHART_OPEN}.open must be a boolean`);
        return null;
      }
      return { type, open: record.open };
    case AGENT_ACTIONS.SET_CHART_TYPE: {
      const chartType = String(record.chartType ?? "").toLowerCase();
      if (!isChartType(chartType)) {
        errors.push(`unsupported chartType: ${String(record.chartType ?? "")}`);
        return null;
      }
      return { type, chartType };
    }
    case AGENT_ACTIONS.SET_CHART_GROUPING: {
      const groupBy = String(record.groupBy ?? "");
      if (!isChartGroupMode(groupBy)) {
        errors.push(`unsupported chart groupBy: ${String(record.groupBy ?? "")}`);
        return null;
      }
      const taskOverrides = validateChartGroupOverrides(record.taskOverrides, columns, errors);
      if (!taskOverrides) return null;
      return { type, groupBy, taskOverrides };
    }
    default: {
      const unhandledAction: never = type;
      errors.push(`unsupported action type: ${unhandledAction}`);
      return null;
    }
  }
}

function validateSortItem(
  input: unknown,
  columns: Field[],
  errors: string[],
): { fieldId: string; sortState: "asc" | "desc" } | null {
  const record = input as AgentSortItemInput;
  const fieldId = normalizeColumnId(record?.fieldId, columns);
  if (!fieldId) {
    errors.push(`invalid sort fieldId: ${String(record?.fieldId ?? "")}`);
    return null;
  }

  const sortState = String(record.sortState ?? "").toLowerCase();
  if (sortState !== "asc" && sortState !== "desc") {
    errors.push(`invalid sortState for ${fieldId}`);
    return null;
  }

  return { fieldId, sortState };
}

function validateCondition(input: unknown, columns: Field[], errors: string[]): AgentFilterCondition | null {
  const record = input as AgentConditionInput;
  const columnId = normalizeColumnId(record?.columnId, columns);
  if (!columnId) {
    errors.push(`invalid filter columnId: ${String(record?.columnId ?? "")}`);
    return null;
  }

  const operator = String(record.operator ?? "").toUpperCase();
  if (!OPERATOR_SET.has(operator)) {
    errors.push(`invalid filter operator for ${columnId}: ${operator}`);
    return null;
  }

  const column = columns.find((candidate) => candidate.id === columnId);
  if (!column || !isFilterOperatorValidForField(column, operator as AgentFilterOperator)) {
    errors.push(
      `filter operator ${operator} is not valid for ${columnId}`,
    );
    return null;
  }

  if (!VALUELESS_OPERATORS.has(operator as AgentFilterOperator) && isBlankFilterValue(record.value)) {
    errors.push(`filter value is required for ${columnId}`);
    return null;
  }

  return {
    columnId,
    operator: operator as AgentFilterOperator,
    value: record.value,
  };
}

function validateChartGroupOverrides(
  input: unknown,
  columns: Field[],
  errors: string[],
): AgentChartGroupOverride[] | null {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    errors.push(`${AGENT_ACTIONS.SET_CHART_GROUPING}.taskOverrides must be an array`);
    return null;
  }

  const taskKeys = taskKeysFromColumnIds(columns.map((column) => column.id));
  const overrides = new Map<string, AgentChartGroupOverride>();
  for (const item of input) {
    const record = item as { taskKey?: unknown; groupBy?: unknown } | null;
    const taskKey = typeof record?.taskKey === "string" ? record.taskKey.trim() : "";
    if (!taskKeys.has(taskKey)) {
      errors.push(`invalid chart grouping taskKey: ${String(record?.taskKey ?? "")}`);
      return null;
    }
    const groupBy = String(record?.groupBy ?? "");
    if (!isTaskChartGroupMode(groupBy)) {
      errors.push(`unsupported chart groupBy for ${taskKey}: ${String(record?.groupBy ?? "")}`);
      return null;
    }
    overrides.set(taskKey, { taskKey, groupBy });
  }
  return [...overrides.values()];
}

function validateColorRule(input: unknown, columns: Field[], errors: string[]): AgentColorRule | null {
  const condition = validateCondition(input, columns, errors);
  if (!condition) return null;

  const record = input as AgentColorRuleInput;
  const color = normalizeTableColor(record.color);
  if (!color) {
    errors.push(`invalid color for ${condition.columnId}: ${String(record.color ?? "")}`);
    return null;
  }

  const targetType = record.targetType === "cell" ? "cell" : record.targetType === "row" ? "row" : null;
  if (!targetType) {
    errors.push(`invalid color targetType for ${condition.columnId}`);
    return null;
  }

  return {
    ...condition,
    color,
    targetType,
  };
}

function normalizeColumnIds(input: unknown[], columns: Field[], errors: string[]) {
  const columnIds: string[] = [];
  for (const item of input) {
    const columnId = normalizeColumnId(item, columns);
    if (columnId) columnIds.push(columnId);
    else errors.push(`invalid columnId: ${String(item ?? "")}`);
  }
  return Array.from(new Set(columnIds));
}

function normalizeColumnId(value: unknown, columns: Field[]) {
  if (typeof value !== "string") return null;
  const needle = normalizeLabel(value);
  const column = columns.find((candidate) => (
    normalizeLabel(candidate.id) === needle ||
    normalizeLabel(candidate.displayName) === needle
  ));
  return column?.id ?? null;
}

function normalizeLabel(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}
