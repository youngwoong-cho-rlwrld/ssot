// Runtime-safe contract shared by the Next application and the standalone
// Claude agent server. Keep enum-like values and palette metadata here so
// prompts, runtime validators, and TypeScript literal types cannot diverge.

export const CHART_TYPES = Object.freeze(
  /** @type {const} */ (["bar", "line", "radar", "heatmap"]),
);

export const DEFAULT_CHART_TYPE = CHART_TYPES[0];

// Per-task chart grouping: which dimension forms the x-axis groups of a task
// chart. The other dimension becomes the in-group series. "auto" groups
// multi-eval-set tasks by eval set and single-eval-set tasks by experiment.
export const TASK_CHART_GROUP_MODES = Object.freeze(
  /** @type {const} */ (["evalSet", "experiment"]),
);

export const CHART_GROUP_MODES = Object.freeze(
  /** @type {const} */ (["auto", ...TASK_CHART_GROUP_MODES]),
);

export const DEFAULT_CHART_GROUP_MODE = CHART_GROUP_MODES[0];

export const FILTER_OPERATORS = Object.freeze(
  /** @type {const} */ ([
    "EQUALS",
    "NOT_EQUALS",
    "CONTAINS",
    "NOT_CONTAINS",
    "STARTS_WITH",
    "NOT_STARTS_WITH",
    "ENDS_WITH",
    "NOT_ENDS_WITH",
    "IN",
    "NOT_IN",
    "GT",
    "GTE",
    "LT",
    "LTE",
    "AFTER",
    "AFTER_OR_ON",
    "BEFORE",
    "BEFORE_OR_ON",
    "EXISTS",
    "NOT_EXISTS",
    "IS_TRUE",
    "IS_FALSE",
  ]),
);

export const VALUELESS_FILTER_OPERATORS = Object.freeze(
  /** @type {const} */ (["EXISTS", "NOT_EXISTS", "IS_TRUE", "IS_FALSE"]),
);

export const FILTER_OPERATORS_BY_FIELD_TYPE = Object.freeze(
  /** @type {const} */ ({
    TEXT: Object.freeze([
      "CONTAINS", "NOT_CONTAINS", "EQUALS", "NOT_EQUALS", "IN", "NOT_IN",
      "STARTS_WITH", "NOT_STARTS_WITH", "ENDS_WITH", "NOT_ENDS_WITH",
      "EXISTS", "NOT_EXISTS",
    ]),
    NUMBER: Object.freeze([
      "GT", "GTE", "LT", "LTE", "EQUALS", "NOT_EQUALS", "EXISTS", "NOT_EXISTS",
    ]),
    DATETIME: Object.freeze([
      "AFTER", "AFTER_OR_ON", "BEFORE", "BEFORE_OR_ON", "EQUALS", "EXISTS", "NOT_EXISTS",
    ]),
    BOOLEAN: Object.freeze(["IS_TRUE", "IS_FALSE", "EXISTS", "NOT_EXISTS"]),
  }),
);

export const TABLE_COLORS = Object.freeze(
  /** @type {const} */ ([
    { value: "#FFF3A5", label: "Lemon" },
    { value: "#FFDCBB", label: "Peach" },
    { value: "#FF9D74", label: "Orange" },
    { value: "#EC7272", label: "Apple" },
    { value: "#F2E7FF", label: "Lavender" },
    { value: "#FFB6D3", label: "Pink" },
    { value: "#DCB2CE", label: "Dullish Pink" },
    { value: "#99AFFF", label: "Cool Blue" },
    { value: "#D7EBE4", label: "Enmight Light" },
    { value: "#C7FFBF", label: "Neon Green" },
    { value: "#B7DE8D", label: "Grass Green" },
    { value: "#49BF91", label: "Vivid Green" },
    { value: "#C1FFF2", label: "Light Teal" },
    { value: "#D0EBFF", label: "Sky Blue" },
    { value: "#74C0FC", label: "Darker Blue" },
    { value: "#C89DFF", label: "Purple" },
  ]),
);
TABLE_COLORS.forEach(Object.freeze);

export const DEFAULT_TABLE_RULE_COLOR = TABLE_COLORS[8].value;
export const DEFAULT_TABLE_COLOR = /** @type {const} */ ("var(--enmight-gray-2)");

export const SHELL_PANE_COMMANDS = Object.freeze(
  /** @type {const} */ (["bash", "fish", "sh", "zsh"]),
);

export const AGENT_SERVER_PANE_COMMANDS = Object.freeze(
  /** @type {const} */ (["node", "npm"]),
);

export const AGENT_ACTIONS = Object.freeze(
  /** @type {const} */ ({
    SET_SORT: "setSort",
    CLEAR_SORT: "clearSort",
    SET_FILTERS: "setFilters",
    CLEAR_FILTERS: "clearFilters",
    SHOW_COLUMNS: "showColumns",
    HIDE_COLUMNS: "hideColumns",
    SET_VISIBLE_COLUMNS: "setVisibleColumns",
    SET_COLOR_RULES: "setColorRules",
    CLEAR_COLORS: "clearColors",
    REFRESH: "refresh",
    SET_CHART_OPEN: "setChartOpen",
    SET_CHART_TYPE: "setChartType",
    SET_CHART_GROUPING: "setChartGrouping",
  }),
);

export const AGENT_ACTION_NAMES = Object.freeze(Object.values(AGENT_ACTIONS));
export const MAX_AGENT_ACTIONS = 32;

export function createAgentResponseSchema() {
  const exampleOperator = FILTER_OPERATORS.find((operator) => operator === "IN") ?? FILTER_OPERATORS[0];
  const defaultRuleColor =
    TABLE_COLORS.find((color) => color.value === DEFAULT_TABLE_RULE_COLOR) ?? TABLE_COLORS[0];

  const actions = [
    { type: AGENT_ACTIONS.SET_SORT, items: [{ fieldId: "columnId", sortState: "asc|desc" }] },
    { type: AGENT_ACTIONS.CLEAR_SORT },
    {
      type: AGENT_ACTIONS.SET_FILTERS,
      conjunction: "and|or",
      conditions: [
        {
          columnId: "columnId",
          operator: exampleOperator,
          value: "exact displayed text 1, exact displayed text 2",
        },
      ],
    },
    { type: AGENT_ACTIONS.CLEAR_FILTERS },
    { type: AGENT_ACTIONS.SHOW_COLUMNS, columnIds: ["columnId"] },
    { type: AGENT_ACTIONS.HIDE_COLUMNS, columnIds: ["columnId"] },
    { type: AGENT_ACTIONS.SET_VISIBLE_COLUMNS, columnIds: ["columnId"] },
    {
      type: AGENT_ACTIONS.SET_COLOR_RULES,
      rules: [
        {
          targetType: "row|cell",
          color: defaultRuleColor.label,
          columnId: "columnId",
          operator: exampleOperator,
          value: "exact displayed text 1, exact displayed text 2",
        },
      ],
    },
    { type: AGENT_ACTIONS.CLEAR_COLORS },
    { type: AGENT_ACTIONS.REFRESH },
    { type: AGENT_ACTIONS.SET_CHART_OPEN, open: true },
    { type: AGENT_ACTIONS.SET_CHART_TYPE, chartType: CHART_TYPES.join("|") },
    {
      type: AGENT_ACTIONS.SET_CHART_GROUPING,
      groupBy: CHART_GROUP_MODES.join("|"),
      taskOverrides: [
        { taskKey: "taskKey", groupBy: TASK_CHART_GROUP_MODES.join("|") },
      ],
    },
  ];

  if (
    actions.length !== AGENT_ACTION_NAMES.length ||
    actions.some((action, index) => action.type !== AGENT_ACTION_NAMES[index])
  ) {
    throw new Error("Agent response schema must cover every action in contract order.");
  }

  return {
    message: "short user-facing summary",
    actions,
  };
}
