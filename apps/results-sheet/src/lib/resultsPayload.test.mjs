import assert from "node:assert/strict";
import test from "node:test";

import { normalizeResultsPayload } from "./resultsPayload.ts";

test("returns a safe empty response for a malformed top-level payload", () => {
  assert.deepEqual(normalizeResultsPayload("not an object", " cluster-a "), {
    variants: [],
    errors: [],
  });
});

test("filters malformed records and sanitizes nested numeric data", () => {
  const normalized = normalizeResultsPayload({
    clusters: [" cluster-a ", "cluster-a", 42, ""],
    variants: [
      null,
      { cluster: "cluster-a", variant: "missing-tasks" },
      {
        cluster: " cluster-a ",
        variant: " valid-variant ",
        job_id: "job-1",
        job_name: "Job One",
        experiment: "experiment-one",
        model_version: "n1.6",
        checkpoint: "/checkpoints/one",
        state_token_count: 0,
        action_token_count: "2",
        completed_at: 123.5,
        expected_task_keys: [" cube_box_5cm_left ", "cube_box_5cm_left", 3],
        expected_eval_sets: [" 0cm ", "1cm", null],
        tasks: [
          { task: "", eval_sets: [] },
          {
            task: " cube_box_5cm_left ",
            task_name: "task-Cube_Box-5cmLeft",
            instruction: 7,
            eval_sets: [
              {
                eval_set: "",
                mean_success_rate: 0.5,
                std_success_rate: 0,
                per_run_success_rate: [],
                success_counts: [],
                episode_counts: [],
                completed_runs: 0,
              },
              {
                eval_set: "0cm",
                mean_success_rate: 0.5,
                std_success_rate: 0,
                per_run_success_rate: "not-an-array",
                success_counts: [],
                episode_counts: [],
                completed_runs: 1,
              },
              {
                eval_set: " 1cm ",
                mean_success_rate: "0.4",
                std_success_rate: Number.POSITIVE_INFINITY,
                per_run_success_rate: [0.2, "bad", 2, 0.6, null],
                success_counts: [2, 5, 3, null, null],
                episode_counts: [10, 10, 2, 10, 10],
                completed_runs: 3,
                expected_runs: 3,
                source: 99,
              },
            ],
          },
        ],
      },
    ],
    errors: [
      { cluster: " cluster-a ", error: " scan failed " },
      { cluster: "cluster-a", error: "" },
      "bad error",
    ],
  }, "cluster-a");

  assert.deepEqual(normalized.errors, [{ cluster: "cluster-a", error: "scan failed" }]);
  assert.equal(normalized.variants.length, 1);

  const variant = normalized.variants[0];
  assert.equal(variant.cluster, "cluster-a");
  assert.equal(variant.variant, "valid-variant");
  assert.equal(variant.job_id, "job-1");
  assert.equal(variant.state_token_count, 0);
  assert.equal(variant.action_token_count, null);
  assert.equal(variant.completed_at, 123.5);
  assert.deepEqual(variant.expected_task_keys, ["cube_box_5cm_left"]);
  assert.deepEqual(variant.expected_eval_sets, ["0cm", "1cm"]);
  assert.equal(variant.tasks.length, 1);

  const task = variant.tasks[0];
  assert.equal(task.task, "cube_box_5cm_left");
  assert.equal(task.eval_sets.length, 1);

  const cell = task.eval_sets[0];
  assert.equal(cell.eval_set, "1cm");
  assert.equal(cell.mean_success_rate, null);
  assert.equal(cell.std_success_rate, null);
  assert.deepEqual(cell.per_run_success_rate, [0.2, 0.5, 0.6]);
  assert.deepEqual(cell.success_counts, [2, 5, null]);
  assert.deepEqual(cell.episode_counts, [10, 10, 10]);
  assert.equal(cell.completed_runs, 3);
  assert.equal(cell.expected_runs, 3);
});

test("enforces the singular cluster boundary and normalizes optional strings and dates", () => {
  const normalized = normalizeResultsPayload({
    variants: [
      { cluster: "other", variant: "wrong-cluster", tasks: [] },
      {
        cluster: "cluster-a",
        variant: "kept",
        job_name: "   ",
        completed_at: Number.MAX_VALUE,
        tasks: [{ task: "task", task_name: "  ", eval_sets: [] }],
      },
    ],
    errors: [
      { cluster: "other", error: "wrong" },
      { cluster: "cluster-a", error: " kept " },
    ],
  }, "cluster-a");

  assert.equal(normalized.variants.length, 1);
  assert.equal(normalized.variants[0].job_name, null);
  assert.equal(normalized.variants[0].completed_at, null);
  assert.equal(normalized.variants[0].tasks[0].task_name, null);
  assert.deepEqual(normalized.errors, [{ cluster: "cluster-a", error: "kept" }]);
});

test("derives missing run rates only from valid aligned counts", () => {
  const normalized = normalizeResultsPayload({
    variants: [{
      cluster: "cluster-a",
      variant: "counts-only",
      tasks: [{
        task: "cube_box_5cm_left",
        eval_sets: [{
          eval_set: "0cm",
          mean_success_rate: 0.75,
          std_success_rate: 0.1,
          per_run_success_rate: [Number.NaN, Number.NEGATIVE_INFINITY],
          success_counts: [3, 5],
          episode_counts: [4, 4],
          completed_runs: 2,
        }],
      }],
    }],
  }, "cluster-a");

  const cell = normalized.variants[0].tasks[0].eval_sets[0];
  assert.deepEqual(cell.per_run_success_rate, [0.75]);
  assert.deepEqual(cell.success_counts, [3]);
  assert.deepEqual(cell.episode_counts, [4]);
  assert.equal(cell.mean_success_rate, 0.75);
  assert.equal(cell.std_success_rate, 0.1);
});
