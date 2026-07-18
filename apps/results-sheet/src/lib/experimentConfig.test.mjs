import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  enrichResultsPayloadWithConfigs,
  parseExperimentConfigText,
  resultsConfigsRoot,
} from "./experimentConfig.ts";

test("resolves the per-request configs root override, validating like the env var", () => {
  const previous = process.env.RESULTS_CONFIGS_ROOT;
  process.env.RESULTS_CONFIGS_ROOT = "/env/configs";
  try {
    // A present override wins over the env value.
    assert.equal(resultsConfigsRoot("/override/configs"), "/override/configs");
    // A relative override resolves against cwd exactly like the env var.
    assert.equal(
      resultsConfigsRoot("rel/configs"),
      path.resolve(process.cwd(), "rel/configs"),
    );
    // Blank, whitespace, and absent overrides fall back to the env value.
    assert.equal(resultsConfigsRoot("   "), "/env/configs");
    assert.equal(resultsConfigsRoot(null), "/env/configs");
    assert.equal(resultsConfigsRoot(undefined), "/env/configs");
    // NUL-byte values are rejected and fall back.
    assert.equal(resultsConfigsRoot("/bad\0/configs"), "/env/configs");
  } finally {
    if (previous === undefined) delete process.env.RESULTS_CONFIGS_ROOT;
    else process.env.RESULTS_CONFIGS_ROOT = previous;
  }
});

test("parses token counts, task matrices, eval sets, quotes, and comments", () => {
  const config = parseExperimentConfigText(`
    TASKS=(
      "cube_box|task-Cube Box|Pick it up"
      'cube_stack|task-Cube Stack|Stack it' # ignored comment
    )
    EVAL_SETS=(0cm 1cm "3cm")
    TRAIN_EXTRA_ARGS=(
      --state-part-token-count 15
      --action-part-token-count "5"
    )
  `);

  assert.deepEqual(config, {
    stateTokenCount: 15,
    actionTokenCount: 5,
    expectedTaskKeys: ["cube_box", "cube_stack"],
    expectedEvalSets: ["0cm", "1cm", "3cm"],
  });
});

test("uses the DexJoCo scalar task contract and deduplicates aliases", () => {
  const config = parseExperimentConfigText(`
    DEXJOCO_TASK=water_plant
    TASK_NAME=water_plant
    EVAL_SETS=(rand_obj)
    TRAIN_EXTRA_ARGS=()
  `);

  assert.deepEqual(config.expectedTaskKeys, ["water_plant"]);
  assert.deepEqual(config.expectedEvalSets, ["rand_obj"]);
  assert.equal(config.stateTokenCount, null);
  assert.equal(config.actionTokenCount, null);
});

test("enriches upstream variants from a bounded local config lookup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "results-configs-"));
  const variant = "physixel_poc3_test";
  const variantDir = path.join(root, variant);
  await mkdir(variantDir);
  await writeFile(path.join(variantDir, "config.sh"), `
    TASKS=("cube_box|task-Cube Box|Pick it up")
    EVAL_SETS=(0cm 5cm)
    TRAIN_EXTRA_ARGS=(--state-part-token-count 15 --action-part-token-count 7)
  `);

  const payload = await enrichResultsPayloadWithConfigs({
    variants: [{ cluster: "test", variant, tasks: [] }],
  }, root);

  assert.deepEqual(payload.variants[0], {
    cluster: "test",
    variant,
    tasks: [],
    state_token_count: 15,
    action_token_count: 7,
    expected_task_keys: ["cube_box"],
    expected_eval_sets: ["0cm", "5cm"],
  });

  payload.variants[0].expected_task_keys.push("poisoned");
  const enrichedAgain = await enrichResultsPayloadWithConfigs({
    variants: [{ cluster: "test", variant, tasks: [] }],
  }, root);
  assert.deepEqual(enrichedAgain.variants[0].expected_task_keys, ["cube_box"]);
});

test("does not allow variant names to escape the config root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "results-configs-"));
  const input = { variants: [{ variant: "../outside", tasks: [] }] };
  assert.deepEqual(await enrichResultsPayloadWithConfigs(input, root), input);
});

test("applies current semantic defaults without mutating the upstream payload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "results-configs-"));
  const input = {
    variants: [
      { variant: "action_horizon_ablation_ah8", tasks: [] },
      { variant: "physixel_poc1_pt9_ps0", tasks: [] },
      { variant: "plain_experiment", tasks: [] },
    ],
  };
  const snapshot = structuredClone(input);

  const enriched = await enrichResultsPayloadWithConfigs(input, root);

  assert.deepEqual(input, snapshot);
  assert.deepEqual(enriched.variants[0], {
    ...input.variants[0],
    state_token_count: 1,
    action_token_count: 1,
    expected_task_keys: [],
    expected_eval_sets: [],
  });
  assert.deepEqual(enriched.variants[1], {
    ...input.variants[1],
    state_token_count: null,
    action_token_count: 1,
    expected_task_keys: [],
    expected_eval_sets: [],
  });
  assert.equal(enriched.variants[2], input.variants[2]);
});
