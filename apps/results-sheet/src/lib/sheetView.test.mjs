import assert from "node:assert/strict";
import test from "node:test";
import { sortSheetRows } from "./sheetView.ts";

function row({ id, group = "main", score = null, variant = id }) {
  return {
    id,
    group,
    experiment: id,
    variant,
    completed: "",
    completedSort: null,
    stateTokens: "",
    stateTokenSort: null,
    actionTokens: "",
    actionTokenSort: null,
    stateEncoder: "",
    actionEncoder: "",
    totalAverage: score == null ? "" : String(score),
    totalAverageValue: score,
    metrics: {},
  };
}

test("keeps missing sort values last in both directions", () => {
  const rows = [
    row({ id: "missing" }),
    row({ id: "high", score: 0.8 }),
    row({ id: "low", score: 0.2 }),
  ];

  const asc = sortSheetRows(rows, [{ id: "sort", fieldId: "totalAverage", sortState: "asc" }]);
  const desc = sortSheetRows(rows, [{ id: "sort", fieldId: "totalAverage", sortState: "desc" }]);

  assert.deepEqual(asc.map(({ id }) => id), ["low", "high", "missing"]);
  assert.deepEqual(desc.map(({ id }) => id), ["high", "low", "missing"]);
});

test("keeps result groups stable ahead of user sort rules", () => {
  const rows = [
    row({ id: "dex-high", group: "dexjoco", score: 0.9 }),
    row({ id: "main-low", group: "main", score: 0.1 }),
  ];

  const sorted = sortSheetRows(rows, [{ id: "sort", fieldId: "totalAverage", sortState: "desc" }]);
  assert.deepEqual(sorted.map(({ id }) => id), ["main-low", "dex-high"]);
});

test("uses natural variant order as a deterministic final tiebreaker", () => {
  const rows = [
    row({ id: "second", score: 0.5, variant: "job-10" }),
    row({ id: "first", score: 0.5, variant: "job-2" }),
  ];

  const sorted = sortSheetRows(rows, [{ id: "sort", fieldId: "totalAverage", sortState: "desc" }]);
  assert.deepEqual(sorted.map(({ id }) => id), ["first", "second"]);
});

test("distinguishes a real zero token count from a missing value", () => {
  const zero = { ...row({ id: "zero" }), stateTokens: "0", stateTokenSort: 0 };
  const one = { ...row({ id: "one" }), stateTokens: "1", stateTokenSort: 1 };
  const missing = row({ id: "missing" });
  const rules = [{ id: "sort", fieldId: "stateTokens", sortState: "asc" }];

  assert.deepEqual(
    sortSheetRows([missing, one, zero], rules).map(({ id }) => id),
    ["zero", "one", "missing"],
  );
});
