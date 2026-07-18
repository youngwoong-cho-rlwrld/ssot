import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_ACTION_NAMES,
  AGENT_ACTIONS,
  CHART_TYPES,
  createAgentResponseSchema,
  DEFAULT_CHART_TYPE,
  DEFAULT_TABLE_COLOR,
  DEFAULT_TABLE_RULE_COLOR,
  FILTER_OPERATORS,
  FILTER_OPERATORS_BY_FIELD_TYPE,
  MAX_AGENT_ACTIONS,
  SHELL_PANE_COMMANDS,
  AGENT_SERVER_PANE_COMMANDS,
  TABLE_COLORS,
  VALUELESS_FILTER_OPERATORS,
} from "./agentContract.mjs";
import { CHART_TYPES as EXPORTED_CHART_TYPES } from "./chartTypes.ts";
import { TABLE_COLORS as EXPORTED_TABLE_COLORS } from "./tablePalette.ts";
import {
  FILTER_OPERATORS as EXPORTED_FILTER_OPERATORS,
  VALUELESS_FILTER_OPERATORS as EXPORTED_VALUELESS_OPERATORS,
} from "../enmight/types/filterTypes.ts";

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

test("typed facades expose the runtime contract by reference", () => {
  assert.equal(EXPORTED_CHART_TYPES, CHART_TYPES);
  assert.equal(EXPORTED_FILTER_OPERATORS, FILTER_OPERATORS);
  assert.equal(EXPORTED_VALUELESS_OPERATORS, VALUELESS_FILTER_OPERATORS);
  assert.equal(EXPORTED_TABLE_COLORS, TABLE_COLORS);
});

test("enum-like contract values are immutable, unique, and internally valid", () => {
  assert.equal(Object.isFrozen(CHART_TYPES), true);
  assert.equal(Object.isFrozen(FILTER_OPERATORS), true);
  assert.equal(Object.isFrozen(FILTER_OPERATORS_BY_FIELD_TYPE), true);
  assert.equal(Object.isFrozen(VALUELESS_FILTER_OPERATORS), true);
  assert.equal(Object.isFrozen(AGENT_ACTIONS), true);
  assert.equal(Object.isFrozen(AGENT_ACTION_NAMES), true);
  assert.equal(Object.isFrozen(SHELL_PANE_COMMANDS), true);
  assert.equal(Object.isFrozen(AGENT_SERVER_PANE_COMMANDS), true);

  assertUnique(CHART_TYPES, "chart types");
  assertUnique(FILTER_OPERATORS, "filter operators");
  assertUnique(AGENT_ACTION_NAMES, "agent action names");
  assertUnique(SHELL_PANE_COMMANDS, "shell pane commands");
  assertUnique(AGENT_SERVER_PANE_COMMANDS, "agent-server pane commands");
  assert.ok(MAX_AGENT_ACTIONS >= AGENT_ACTION_NAMES.length);
  assert.equal(CHART_TYPES.includes(DEFAULT_CHART_TYPE), true);
  assert.equal(
    VALUELESS_FILTER_OPERATORS.every((operator) => FILTER_OPERATORS.includes(operator)),
    true,
  );
  for (const operators of Object.values(FILTER_OPERATORS_BY_FIELD_TYPE)) {
    assert.equal(Object.isFrozen(operators), true);
    assert.equal(operators.every((operator) => FILTER_OPERATORS.includes(operator)), true);
  }
  assert.deepEqual(AGENT_ACTION_NAMES, Object.values(AGENT_ACTIONS));
});

test("table palette metadata and defaults are valid", () => {
  assert.equal(Object.isFrozen(TABLE_COLORS), true);
  assertUnique(TABLE_COLORS.map((color) => color.value), "table color values");
  assertUnique(TABLE_COLORS.map((color) => color.label), "table color labels");

  for (const color of TABLE_COLORS) {
    assert.equal(Object.isFrozen(color), true);
    assert.match(color.value, /^#[0-9A-F]{6}$/);
    assert.ok(color.label);
  }

  assert.equal(TABLE_COLORS.some((color) => color.value === DEFAULT_TABLE_RULE_COLOR), true);
  assert.match(DEFAULT_TABLE_COLOR, /^var\(--[a-z0-9-]+\)$/);
});

test("generated agent response schema covers the action contract exactly", () => {
  const schema = createAgentResponseSchema();
  const schemaActionNames = schema.actions.map((action) => action.type);
  assert.deepEqual(schemaActionNames, AGENT_ACTION_NAMES);

  const chartAction = schema.actions.find((action) => action.type === AGENT_ACTIONS.SET_CHART_TYPE);
  assert.equal(chartAction?.chartType, CHART_TYPES.join("|"));

  const filterAction = schema.actions.find((action) => action.type === AGENT_ACTIONS.SET_FILTERS);
  assert.equal(FILTER_OPERATORS.includes(filterAction?.conditions?.[0]?.operator), true);

  const colorAction = schema.actions.find((action) => action.type === AGENT_ACTIONS.SET_COLOR_RULES);
  assert.equal(
    TABLE_COLORS.some((color) => color.label === colorAction?.rules?.[0]?.color),
    true,
  );
});
