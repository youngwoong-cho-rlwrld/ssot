import assert from "node:assert/strict";
import test from "node:test";

import { buildSheetModel } from "./results.ts";

const BASELINE_EXPERIMENT = "n16_multitask_3tasks_480";

function resultCell(evalSet, rate, completedRuns = 3, expectedRuns = 3) {
  return {
    eval_set: evalSet,
    mean_success_rate: rate,
    std_success_rate: 0,
    per_run_success_rate: [rate],
    success_counts: [rate * 10],
    episode_counts: [10],
    completed_runs: completedRuns,
    expected_runs: expectedRuns,
  };
}

function resultTask(evalSets) {
  return {
    task: "cube_box_5cm_left",
    task_name: "task-Cube_Box-5cmLeft",
    eval_sets: evalSets,
  };
}

function resultVariant(variant, tasks, expectedEvalSets) {
  return {
    cluster: "test",
    variant,
    expected_task_keys: ["cube_box_5cm_left"],
    expected_eval_sets: expectedEvalSets,
    completed_at: 1_700_000_000,
    tasks,
  };
}

function modelFor(...variants) {
  return buildSheetModel({ variants, errors: [] });
}

test("keeps the intended displayed columns", () => {
  const model = modelFor();
  const cubeColumns = model.performanceColumns.filter(
    (column) => column.taskKey === "cube_box_5cm_left",
  );

  assert.deepEqual(cubeColumns.map((column) => column.evalSet), ["0cm", "1cm", "3cm"]);
  assert.equal(model.performanceColumns.some((column) => column.evalSet === "5cm"), false);
  assert.equal(model.performanceColumns.some((column) => column.evalSet === "7cm"), false);
});

test("requires configured hidden eval sets before marking a row complete", () => {
  const expectedEvalSets = ["0cm", "1cm", "3cm", "5cm", "7cm"];
  const visibleOnly = resultVariant(
    "visible-only",
    [resultTask([resultCell("0cm", 0.1), resultCell("1cm", 0.2), resultCell("3cm", 0.3)])],
    expectedEvalSets,
  );
  const incompleteRow = modelFor(visibleOnly).rows[0];

  assert.equal(incompleteRow.completed, "Not Complete");
  assert.equal(incompleteRow.totalAverageValue, null);

  const fullyEvaluated = resultVariant(
    "fully-evaluated",
    [resultTask([
      resultCell("0cm", 0.1),
      resultCell("1cm", 0.2),
      resultCell("3cm", 0.3),
      resultCell("5cm", 1),
      resultCell("7cm", 1),
    ])],
    expectedEvalSets,
  );
  const completeRow = modelFor(fullyEvaluated).rows[0];

  assert.notEqual(completeRow.completed, "Not Complete");
  assert.equal(completeRow.totalAverage, "20.00%");
});

test("uses one deterministic cell for display, completion, and totals", () => {
  const duplicateCells = [
    resultCell("0cm", 0.1, 1, 3),
    resultCell("0cm", 0.8, 3, 3),
  ];
  const row = modelFor(
    resultVariant("duplicate-cells", [resultTask(duplicateCells)], ["0cm"]),
  ).rows[0];

  assert.notEqual(row.completed, "Not Complete");
  assert.equal(row.metrics["cube_box_5cm_left::0cm"].display, "80.00% ± 0.00%");
  assert.equal(row.totalAverage, "80.00%");
});

test("maps real single-task names to the exact displayed catalog task", () => {
  const evalSets = ["0cm", "1cm", "3cm", "5cm", "7cm"];
  const variant = resultVariant(
    "n16_baseline_scratch",
    [{
      task: "n16_baseline_scratch",
      task_name: "task-Cube_Box-5cmLeft",
      eval_sets: evalSets.map((evalSet) => resultCell(evalSet, 0.5)),
    }],
    evalSets,
  );
  const row = modelFor(variant).rows[0];

  assert.equal(row.metrics["cube_box_5cm_left::0cm"].display, "50.00% ± 0.00%");
  assert.equal(row.totalAverage, "50.00%");
  assert.notEqual(row.completed, "Not Complete");
});

test("baseline average includes only complete rows that contribute a total", () => {
  const expectedEvalSets = ["0cm", "1cm", "3cm", "5cm", "7cm"];
  const completeBaseline = (rate) => resultVariant(
    BASELINE_EXPERIMENT,
    [resultTask(expectedEvalSets.map((evalSet) => resultCell(evalSet, rate)))],
    expectedEvalSets,
  );
  const incompleteBaseline = resultVariant(
    BASELINE_EXPERIMENT,
    [resultTask([
      resultCell("0cm", 0.99),
      resultCell("1cm", 0.99),
      resultCell("3cm", 0.99),
    ])],
    expectedEvalSets,
  );

  const model = modelFor(
    completeBaseline(0.2),
    completeBaseline(0.6),
    incompleteBaseline,
  );

  assert.equal(model.rows.length, 1);
  assert.equal(
    model.rows[0].variant,
    `average of 2 complete ${BASELINE_EXPERIMENT} jobs`,
  );
  assert.equal(model.rows[0].totalAverage, "40.00%");
  assert.equal(model.rows[0].metrics["cube_box_5cm_left::0cm"].display, "40.00%");
});
