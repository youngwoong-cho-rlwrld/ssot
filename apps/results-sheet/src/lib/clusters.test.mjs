import assert from "node:assert/strict";
import test from "node:test";

import {
  isValidClusterName,
  MAX_CLUSTER_COUNT,
  normalizeClusterNames,
} from "./clusters.ts";

test("validates the singular cluster-name contract", () => {
  assert.equal(isValidClusterName("kakao-1.prod"), true);
  assert.equal(isValidClusterName(" bad"), false);
  assert.equal(isValidClusterName("bad/cluster"), false);
  assert.equal(isValidClusterName("-bad"), false);
});

test("normalizes, deduplicates, and caps upstream cluster lists", () => {
  const names = normalizeClusterNames([
    " kakao ",
    "kakao",
    "bad/cluster",
    ...Array.from({ length: MAX_CLUSTER_COUNT + 10 }, (_, index) => `cluster-${index}`),
  ]);
  assert.equal(names[0], "kakao");
  assert.equal(names.length, MAX_CLUSTER_COUNT);
  assert.equal(new Set(names).size, names.length);
});
