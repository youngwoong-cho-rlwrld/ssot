import assert from "node:assert/strict";
import test from "node:test";
import { validateAgentEnvelope } from "./agentActions.ts";

const columns = [
  { id: "experiment", displayName: "Experiments", type: "TEXT" },
  { id: "stateTokens", displayName: "State Tokens", type: "NUMBER" },
  { id: "pick_bucket::rand_obj", displayName: "Pick Bucket rand_obj", type: "TEXT" },
];

test("rejects malformed envelopes instead of silently accepting empty actions", () => {
  for (const input of [null, [], {}, { message: "ok" }, { message: "ok", actions: {} }]) {
    assert.equal(validateAgentEnvelope(input, columns).envelope, null);
  }
});

test("resolves column labels and accepts programmatic valueless operators", () => {
  const result = validateAgentEnvelope({
    message: "filtered",
    actions: [{
      type: "setFilters",
      conjunction: "and",
      conditions: [{ columnId: "Experiments", operator: "exists" }],
    }],
  }, columns);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.envelope.actions[0], {
    type: "setFilters",
    conjunction: "and",
    conditions: [{ columnId: "experiment", operator: "EXISTS", value: undefined }],
  });
});

test("rejects empty array values and operators incompatible with the field", () => {
  const emptyArray = validateAgentEnvelope({
    message: "bad",
    actions: [{
      type: "setFilters",
      conjunction: "and",
      conditions: [{ columnId: "experiment", operator: "IN", value: [] }],
    }],
  }, columns);
  const wrongOperator = validateAgentEnvelope({
    message: "bad",
    actions: [{
      type: "setFilters",
      conjunction: "and",
      conditions: [{ columnId: "stateTokens", operator: "CONTAINS", value: "1" }],
    }],
  }, columns);

  assert.equal(emptyArray.envelope, null);
  assert.match(emptyArray.errors.join(" "), /value is required/);
  assert.equal(wrongOperator.envelope, null);
  assert.match(wrongOperator.errors.join(" "), /not valid/);
});

test("validates chart grouping against known task keys and modes", () => {
  const valid = validateAgentEnvelope({
    message: "grouped",
    actions: [{
      type: "setChartGrouping",
      groupBy: "auto",
      taskOverrides: [
        { taskKey: "pick_bucket", groupBy: "experiment" },
        { taskKey: "pick_bucket", groupBy: "evalSet" },
      ],
    }],
  }, columns);
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.envelope.actions[0], {
    type: "setChartGrouping",
    groupBy: "auto",
    taskOverrides: [{ taskKey: "pick_bucket", groupBy: "evalSet" }],
  });

  const withoutOverrides = validateAgentEnvelope({
    message: "grouped",
    actions: [{ type: "setChartGrouping", groupBy: "evalSet" }],
  }, columns);
  assert.deepEqual(withoutOverrides.errors, []);
  assert.deepEqual(withoutOverrides.envelope.actions[0].taskOverrides, []);

  for (const action of [
    { type: "setChartGrouping", groupBy: "pie" },
    { type: "setChartGrouping", groupBy: "auto", taskOverrides: [{ taskKey: "unknown", groupBy: "evalSet" }] },
    { type: "setChartGrouping", groupBy: "auto", taskOverrides: [{ taskKey: "pick_bucket", groupBy: "auto" }] },
  ]) {
    const result = validateAgentEnvelope({ message: "grouped", actions: [action] }, columns);
    assert.equal(result.envelope, null);
    assert.ok(result.errors.length);
  }
});

test("rejects duplicate sort fields as one atomic envelope", () => {
  const result = validateAgentEnvelope({
    message: "bad",
    actions: [{
      type: "setSort",
      items: [
        { fieldId: "experiment", sortState: "asc" },
        { fieldId: "Experiments", sortState: "desc" },
      ],
    }],
  }, columns);

  assert.equal(result.envelope, null);
  assert.match(result.errors.join(" "), /duplicate fields/);
});

test("normalizes named and hexadecimal palette colors", () => {
  const actions = ["Enmight Light", "#d7ebe4"].map((color) => ({
    type: "setColorRules",
    rules: [{
      targetType: "row",
      color,
      columnId: "experiment",
      operator: "EQUALS",
      value: "baseline",
    }],
  }));
  const result = validateAgentEnvelope({ message: "colored", actions }, columns);

  assert.deepEqual(result.errors, []);
  assert.equal(result.envelope.actions[0].rules[0].color, "#D7EBE4");
  assert.equal(result.envelope.actions[1].rules[0].color, "#D7EBE4");
});
