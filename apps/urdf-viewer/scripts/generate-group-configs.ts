import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALLEX_STATE_SIZE, allexStateIndexToJointNames } from "../src/allexMapping";
import { colorForIndex } from "../src/colors";
import type { NeckOrder } from "../src/types";

const outputDir = join(process.cwd(), "public/assets/default/group-configs");

type GroupConfigInput = {
  id: string;
  title: string;
  mode: string;
  tokenCount: number;
  seed: number | null;
  stateGroups: number[][];
  groupNames?: string[];
  neckOrder: NeckOrder;
};

const permutations: Record<string, number[]> = {
  ps0: [
    1, 33, 36, 0, 20, 23, 14, 12, 7, 28, 44, 47, 46, 5, 42, 11, 21, 27, 15, 10, 45, 3, 9, 4, 39, 29, 38, 17, 35, 41, 40, 6, 34,
    18, 8, 43, 13, 37, 22, 30, 19, 25, 31, 32, 16, 2, 26, 24,
  ],
  ps1: [
    44, 15, 45, 9, 5, 35, 2, 14, 19, 34, 33, 46, 40, 26, 11, 38, 37, 12, 21, 17, 20, 22, 29, 32, 10, 3, 18, 43, 25, 23,
    47, 41, 0, 27, 39, 1, 42, 6, 13, 24, 30, 28, 31, 7, 16, 4, 36, 8,
  ],
  ps2: [
    24, 33, 47, 35, 6, 15, 4, 22, 9, 29, 34, 21, 18, 37, 26, 20, 7, 41, 17, 45, 30, 39, 12, 36, 14, 11, 0, 1, 31, 8, 40,
    28, 44, 32, 25, 27, 43, 2, 13, 38, 16, 19, 42, 10, 23, 46, 5, 3,
  ],
};

const randomSizes: Record<number, number[]> = {
  3: [16, 16, 16],
  5: [10, 10, 10, 9, 9],
  7: [7, 7, 7, 7, 7, 7, 6],
  9: [6, 6, 6, 5, 5, 5, 5, 5, 5],
  11: [5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4],
  15: [4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
};

const semanticPartitions: Record<number, number[][]> = {
  3: [
    [44, 45, 46, 47],
    [7, 8, 9, 10, 11, 12, 13, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43],
    [0, 1, 2, 3, 4, 5, 6, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28],
  ],
  5: [
    [44, 45, 46, 47],
    [7, 8, 9, 10, 11, 12, 13],
    [0, 1, 2, 3, 4, 5, 6],
    [29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43],
    [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28],
  ],
  7: [
    [44, 45, 46, 47],
    [7, 8, 9, 10, 11, 12, 13],
    [0, 1, 2, 3, 4, 5, 6],
    [29, 30, 31, 32, 33, 34],
    [35, 36, 37, 38, 39, 40, 41, 42, 43],
    [14, 15, 16, 17, 18, 19],
    [20, 21, 22, 23, 24, 25, 26, 27, 28],
  ],
  9: [
    [44, 45, 46, 47],
    [7, 8, 9, 10, 11, 12, 13],
    [0, 1, 2, 3, 4, 5, 6],
    [29, 30, 31],
    [32, 33, 34],
    [35, 36, 37, 38, 39, 40, 41, 42, 43],
    [14, 15, 16],
    [17, 18, 19],
    [20, 21, 22, 23, 24, 25, 26, 27, 28],
  ],
  11: [
    [44, 45, 46, 47],
    [7, 8, 9, 10, 11, 12, 13],
    [0, 1, 2, 3, 4, 5, 6],
    [29, 30, 31],
    [32, 33, 34],
    [35, 36, 37],
    [38, 39, 40, 41, 42, 43],
    [14, 15, 16],
    [17, 18, 19],
    [20, 21, 22],
    [23, 24, 25, 26, 27, 28],
  ],
};

const semanticNames: Record<number, string[]> = {
  3: ["Torso", "Left side", "Right side"],
  5: ["Torso", "Left arm", "Right arm", "Left hand", "Right hand"],
  7: ["Torso", "Left arm", "Right arm", "Left hand A", "Left hand B", "Right hand A", "Right hand B"],
  9: ["Torso", "Left arm", "Right arm", "Left thumb", "Left finger base", "Left finger distal", "Right thumb", "Right finger base", "Right finger distal"],
  11: [
    "Torso",
    "Left arm",
    "Right arm",
    "Left thumb",
    "Left finger base",
    "Left finger middle",
    "Left finger distal",
    "Right thumb",
    "Right finger base",
    "Right finger middle",
    "Right finger distal",
  ],
};

function splitPermutation(permutation: number[], sizes: number[]): number[][] {
  const groups: number[][] = [];
  let cursor = 0;
  for (const size of sizes) {
    groups.push(permutation.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

function validateStateGroups(label: string, stateGroups: number[][]) {
  const flat = stateGroups.flat();
  const sorted = [...flat].sort((a, b) => a - b);
  const expected = Array.from({ length: ALLEX_STATE_SIZE }, (_, index) => index);
  if (flat.length !== ALLEX_STATE_SIZE || sorted.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} must cover state indices 0-${ALLEX_STATE_SIZE - 1} exactly once.`);
  }
}

function expandStateGroup(stateGroup: number[], stateIndexToJoints: string[][]): string[] {
  return [...new Set(stateGroup.flatMap((index) => stateIndexToJoints[index]))];
}

function createConfig({ id, title, mode, tokenCount, seed, stateGroups, groupNames, neckOrder }: GroupConfigInput) {
  validateStateGroups(id, stateGroups);
  const stateIndexToJoints = allexStateIndexToJointNames(neckOrder);
  const groups = stateGroups.map((_, index) => ({
    id: `${id}-part-${String(index + 1).padStart(2, "0")}`,
    name: groupNames?.[index] ?? `Part ${String(index + 1).padStart(2, "0")}`,
    color: colorForIndex(index),
  }));
  const nodesByGroup: Record<string, string[]> = {};
  const joints: Record<string, { color: string; groupId: string; gizmo: boolean }> = {};

  groups.forEach((group, index) => {
    const nodes = expandStateGroup(stateGroups[index], stateIndexToJoints);
    nodesByGroup[group.id] = nodes;
    nodes.forEach((jointName) => {
      joints[jointName] = {
        color: group.color,
        groupId: group.id,
        gizmo: false,
      };
    });
  });

  return {
    version: 1,
    modelName: "ALLEX",
    groups,
    joints,
    nodesByGroup,
    showJointGizmos: true,
    metadata: {
      title,
      source: "ALLEX PoC1 joint-group preset",
      mode,
      tokenCount,
      seed,
      neckOrder,
      stateGroups,
      stateIndexNote:
        neckOrder === "urdf-pitch-yaw"
          ? "State indices follow URDF/export neck order: 0-6 right arm, 7-13 left arm, 14-28 right hand compact joints, 29-43 left hand compact joints, 44 Neck_Pitch, 45 Neck_Yaw, 46-47 waist. Compact hand and waist pitch state indices expand to their driven URDF joints."
          : "State indices follow carrier neck order: 0-6 right arm, 7-13 left arm, 14-28 right hand compact joints, 29-43 left hand compact joints, 44 Neck_Yaw, 45 Neck_Pitch, 46-47 waist. Compact hand and waist pitch state indices expand to their driven URDF joints.",
    },
  };
}

mkdirSync(outputDir, { recursive: true });

const manifest: Array<{
  file: string;
  title: string;
  mode: string;
  tokenCount: number;
  seed: number | null;
  neckOrder: NeckOrder;
  groupCount: number;
}> = [];

function writeConfig(filename: string, config: ReturnType<typeof createConfig>) {
  writeFileSync(join(outputDir, filename), `${JSON.stringify(config, null, 2)}\n`);
  manifest.push({
    file: filename,
    title: config.metadata.title,
    mode: config.metadata.mode,
    tokenCount: config.metadata.tokenCount,
    seed: config.metadata.seed,
    neckOrder: config.metadata.neckOrder,
    groupCount: config.groups.length,
  });
}

const variants = [
  { prefix: "", titleSuffix: "", neckOrder: "carrier-yaw-pitch" as const },
  { prefix: "urdf-neck-", titleSuffix: " URDF neck order", neckOrder: "urdf-pitch-yaw" as const },
];

for (const variant of variants) {
  writeConfig(
    `${variant.prefix}baseline-pt1.json`,
    createConfig({
      id: `${variant.prefix}baseline-pt1`,
      title: `Baseline 1 token${variant.titleSuffix}`,
      mode: "baseline",
      tokenCount: 1,
      seed: null,
      neckOrder: variant.neckOrder,
      stateGroups: [Array.from({ length: ALLEX_STATE_SIZE }, (_, index) => index)],
    }),
  );

  for (const [seed, permutation] of Object.entries(permutations)) {
    for (const [tokenCountText, sizes] of Object.entries(randomSizes)) {
      const tokenCount = Number(tokenCountText);
      writeConfig(
        `${variant.prefix}random-pt${tokenCount}-${seed}.json`,
        createConfig({
          id: `${variant.prefix}random-pt${tokenCount}-${seed}`,
          title: `Random balanced ${tokenCount} tokens ${seed}${variant.titleSuffix}`,
          mode: "random_balanced",
          tokenCount,
          seed: Number(seed.slice(2)),
          neckOrder: variant.neckOrder,
          stateGroups: splitPermutation(permutation, sizes),
        }),
      );
    }
  }

  for (const [tokenCountText, stateGroups] of Object.entries(semanticPartitions)) {
    const tokenCount = Number(tokenCountText);
    writeConfig(
      `${variant.prefix}semantic-pt${tokenCount}.json`,
      createConfig({
        id: `${variant.prefix}semantic-pt${tokenCount}`,
        title: `Semantic ${tokenCount} tokens${variant.titleSuffix}`,
        mode: "semantic_explicit",
        tokenCount,
        seed: null,
        neckOrder: variant.neckOrder,
        stateGroups,
        groupNames: semanticNames[tokenCount],
      }),
    );
  }
}

writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  join(outputDir, "README.md"),
  [
    "# ALLEX Joint Group Configs",
    "",
    "Load any `.json` file from this directory with the viewer's Groups -> Load control.",
    "",
    "Generated ALLEX joint-group presets for the PoC1 task set.",
    "",
    "Files:",
    ...manifest.map((item) => `- \`${item.file}\`: ${item.title}`),
    "",
  ].join("\n"),
);

console.log(`Wrote ${manifest.length} configs to ${outputDir}`);
