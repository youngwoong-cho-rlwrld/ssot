export type ResultCell = {
  eval_set: string;
  mean_success_rate: number | null;
  std_success_rate: number | null;
  per_run_success_rate: number[];
  success_counts: Array<number | null>;
  episode_counts: Array<number | null>;
  completed_runs: number;
  expected_runs?: number | null;
};

export type ResultTask = {
  task: string;
  task_name?: string | null;
  eval_sets: ResultCell[];
};

export type ResultVariant = {
  cluster: string;
  job_id?: string | null;
  job_name?: string | null;
  variant: string;
  experiment?: string | null;
  model_version?: string | null;
  checkpoint?: string | null;
  state_token_count?: number | null;
  action_token_count?: number | null;
  expected_task_keys?: string[];
  expected_eval_sets?: string[];
  source?: string | null;
  completed_at?: number | null;
  tasks: ResultTask[];
};

export type ResultsResponse = {
  variants: ResultVariant[];
  errors: Array<{ cluster: string; error: string }>;
  fetchedAt?: Record<string, number>;
  stale?: boolean;
};

export type PerformanceColumn = {
  id: string;
  label: string;
  taskKey: string;
  evalSet: string;
};

type MetricValue = {
  display: string;
  value: number | null;
};

// DexJoCo evals are single-task, so they render as their own section below the
// multi-task Isaac comparison rather than interleaving with it by score.
type ResultGroup = "main" | "dexjoco";
export const GROUP_RANK: Record<ResultGroup, number> = { main: 0, dexjoco: 1 };

export type SheetRow = {
  id: string;
  group: ResultGroup;
  experiment: string;
  variant: string;
  completed: string;
  completedSort: number | null;
  stateTokens: string;
  stateTokenSort: number | null;
  actionTokens: string;
  actionTokenSort: number | null;
  stateEncoder: string;
  actionEncoder: string;
  totalAverage: string;
  totalAverageValue: number | null;
  metrics: Record<string, MetricValue>;
};

type SheetModel = {
  rows: SheetRow[];
  performanceColumns: PerformanceColumn[];
  errors: ResultsResponse["errors"];
};

type TaskCatalogEntry = {
  key: string;
  label: string;
  aliases: readonly string[];
  group: ResultGroup;
  displayEvalSets: readonly string[];
};

// This is the single source of truth for task identity, grouping, and the
// columns shown by this viewer. Configured eval sets that are not displayed
// here still participate in completion checks.
const TASK_CATALOG: readonly TaskCatalogEntry[] = [
  {
    key: "cube_box_5cm_left",
    label: "Cube_Box-5cmLeft",
    aliases: ["cube_box_5cm_left", "cube_box_5cmleft", "task-cube_box-5cmleft"],
    group: "main",
    displayEvalSets: ["0cm", "1cm", "3cm"],
  },
  {
    key: "cube_stack_3cm_right",
    label: "Cube_Stack-3cmRight",
    aliases: ["cube_stack_3cm_right", "cube_stack_3cmright", "task-cube_stack-3cmright"],
    group: "main",
    displayEvalSets: ["0cm", "1cm", "3cm"],
  },
  {
    key: "cylinder_tube_place_7cm_left",
    label: "Cylinder_Tube_Place-T15cmC7cmLeft",
    aliases: [
      "cylinder_tube_place_7cm_left",
      "cylinder_tube_place_t15cmc7cmleft",
      "task-cylinder_tube_place-t15cmc7cmleft",
    ],
    group: "main",
    displayEvalSets: ["0cm", "1cm", "3cm"],
  },
  {
    key: "water_plant",
    label: "DexJoCo Water Plant",
    aliases: ["water_plant"],
    group: "dexjoco",
    displayEvalSets: ["rand_obj"],
  },
  {
    key: "click_mouse",
    label: "DexJoCo Click Mouse",
    aliases: ["click_mouse"],
    group: "dexjoco",
    displayEvalSets: ["rand_obj"],
  },
  {
    key: "fold_glasses",
    label: "DexJoCo Fold Glasses",
    aliases: ["fold_glasses"],
    group: "dexjoco",
    displayEvalSets: ["rand_obj"],
  },
  {
    key: "hammer_nail",
    label: "DexJoCo Hammer Nail",
    aliases: ["hammer_nail"],
    group: "dexjoco",
    displayEvalSets: ["rand_obj"],
  },
  {
    key: "pick_bucket",
    label: "DexJoCo Pick Bucket",
    aliases: ["pick_bucket"],
    group: "dexjoco",
    displayEvalSets: ["rand_obj"],
  },
  {
    key: "pinch_tongs",
    label: "DexJoCo Pinch Tongs",
    aliases: ["pinch_tongs"],
    group: "dexjoco",
    displayEvalSets: ["rand_obj"],
  },
  {
    key: "bimanual_assembly",
    label: "DexJoCo Bimanual Assembly",
    aliases: ["bimanual_assembly"],
    group: "dexjoco",
    displayEvalSets: ["rand_obj"],
  },
  {
    key: "bimanual_hanoi",
    label: "DexJoCo Bimanual Hanoi",
    aliases: ["bimanual_hanoi"],
    group: "dexjoco",
    displayEvalSets: ["rand_obj"],
  },
  {
    key: "bimanual_microwave_cook",
    label: "DexJoCo Bimanual Microwave Cook",
    aliases: ["bimanual_microwave_cook"],
    group: "dexjoco",
    displayEvalSets: ["rand_obj"],
  },
  {
    key: "bimanual_photograph",
    label: "DexJoCo Bimanual Photograph",
    aliases: ["bimanual_photograph"],
    group: "dexjoco",
    displayEvalSets: ["rand_obj"],
  },
  {
    key: "bimanual_unlock_ipad",
    label: "DexJoCo Bimanual Unlock iPad",
    aliases: ["bimanual_unlock_ipad"],
    group: "dexjoco",
    displayEvalSets: ["rand_obj"],
  },
];

const TASK_CATALOG_BY_KEY = new Map(TASK_CATALOG.map((task) => [task.key, task]));
const TASK_KEYS_BY_GROUP: Record<ResultGroup, ReadonlySet<string>> = {
  main: new Set(TASK_CATALOG.filter((task) => task.group === "main").map((task) => task.key)),
  dexjoco: new Set(TASK_CATALOG.filter((task) => task.group === "dexjoco").map((task) => task.key)),
};
const PERFORMANCE_COLUMNS: PerformanceColumn[] = TASK_CATALOG.flatMap((task) =>
  task.displayEvalSets.map((evalSet) => ({
    id: performanceCellId(task.key, evalSet),
    label: `${task.label} ${evalSet}`,
    taskKey: task.key,
    evalSet,
  })),
);
const BASELINE_EXPERIMENT = "n16_multitask_3tasks_480";
const EXCLUDED_EXPERIMENTS = new Set([
  "n16_cube_box_5cm_left_480",
  "n16_cylinder_tube_place_7cm_left_480",
  "n16_cube_stack_3cm_right_480",
  "n16_cylinder_tube_place_5cm_right_480",
  BASELINE_EXPERIMENT,
]);

type BuiltSheetRow = {
  row: SheetRow;
  complete: boolean;
};

export function buildSheetModel(response: ResultsResponse): SheetModel {
  const performanceColumns = PERFORMANCE_COLUMNS;
  const builtRows = response.variants.map((variant) => toSheetRow(variant, performanceColumns));
  const baselineRow = buildBaselineAverageRow(
    builtRows.filter(({ row }) => row.experiment === BASELINE_EXPERIMENT),
    performanceColumns,
  );
  const rows = [
    ...builtRows
      .map(({ row }) => row)
      .filter((row) => !EXCLUDED_EXPERIMENTS.has(row.experiment)),
    ...(baselineRow ? [baselineRow] : []),
  ]
    .sort((a, b) => {
      const groupDelta = GROUP_RANK[a.group] - GROUP_RANK[b.group];
      if (groupDelta !== 0) return groupDelta;
      const scoreDelta = (b.totalAverageValue ?? -1) - (a.totalAverageValue ?? -1);
      if (scoreDelta !== 0) return scoreDelta;
      return a.variant.localeCompare(b.variant, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
  return {
    rows,
    performanceColumns,
    errors: response.errors ?? [],
  };
}

function buildBaselineAverageRow(
  baselineRows: BuiltSheetRow[],
  performanceColumns: PerformanceColumn[],
): SheetRow | null {
  const contributors = baselineRows
    .filter(({ complete, row }) => complete && row.totalAverageValue != null)
    .map(({ row }) => row);
  if (!contributors.length) return null;

  const totalAverageValue = averageValues(contributors.map((row) => row.totalAverageValue));
  const metrics: Record<string, MetricValue> = {};

  for (const column of performanceColumns) {
    const value = averageValues(contributors.map((row) => row.metrics[column.id]?.value ?? null));
    metrics[column.id] = {
      display: value == null ? "" : formatPct(value),
      value,
    };
  }

  return {
    id: "baseline-average",
    group: "main",
    experiment: "baseline average",
    variant: `average of ${contributors.length} complete ${BASELINE_EXPERIMENT} jobs`,
    completed: "",
    completedSort: null,
    stateTokens: "1",
    stateTokenSort: 1,
    actionTokens: "1",
    actionTokenSort: 1,
    stateEncoder: "Shared",
    actionEncoder: "",
    totalAverage: totalAverageValue == null ? "" : formatPct(totalAverageValue),
    totalAverageValue,
    metrics,
  };
}

function averageValues(values: Array<number | null | undefined>) {
  const validValues = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (!validValues.length) return null;
  return validValues.reduce((sum, value) => sum + value, 0) / validValues.length;
}

type NormalizedVariantResults = {
  cells: Map<string, ResultCell>;
  taskKeys: Set<string>;
  evalSetsByTask: Map<string, Set<string>>;
};

function toSheetRow(
  variant: ResultVariant,
  performanceColumns: PerformanceColumn[],
): BuiltSheetRow {
  const normalized = normalizeVariantResults(variant.tasks);
  const group = resultGroupForVariant(variant, normalized.taskKeys);
  const expectedCellIds = expectedCellIdsForVariant(variant, normalized, group);
  const complete = expectedCellIds.size > 0 && isVariantComplete(normalized, expectedCellIds);
  const metrics: Record<string, MetricValue> = {};

  for (const column of performanceColumns) {
    const cell = normalized.cells.get(column.id);
    metrics[column.id] = cell
      ? {
          display: formatMeanStd(cell),
          value: cell.mean_success_rate,
        }
      : { display: "", value: null };
  }

  const displayedExpectedCellIds = performanceColumns
    .map((column) => column.id)
    .filter((cellId) => expectedCellIds.has(cellId));
  const totalAverage = complete
    ? totalWeightedAverage(normalized.cells, displayedExpectedCellIds)
    : null;
  const jobSuffix = variant.job_id ? ` (${variant.job_id})` : "";
  const jobDisplayName = variant.job_name || variant.experiment || variant.variant;

  return {
    complete,
    row: {
      id: [
        variant.cluster,
        variant.variant,
        variant.source,
        variant.job_id,
        variant.checkpoint,
      ]
        .filter(Boolean)
        .join(":"),
      group,
      experiment: variant.variant,
      variant: `${jobDisplayName}${jobSuffix}`,
      completed: complete ? formatCompletedAt(variant.completed_at) : "Not Complete",
      completedSort: complete ? variant.completed_at ?? null : null,
      stateTokens: formatTokenCount(variant.state_token_count),
      stateTokenSort: variant.state_token_count ?? null,
      actionTokens: formatTokenCount(variant.action_token_count),
      actionTokenSort: variant.action_token_count ?? null,
      stateEncoder: "Shared",
      actionEncoder: "",
      totalAverage: totalAverage == null ? "" : formatPct(totalAverage),
      totalAverageValue: totalAverage,
      metrics,
    },
  };
}

function normalizeVariantResults(tasks: ResultTask[]): NormalizedVariantResults {
  const cells = new Map<string, ResultCell>();
  const taskKeys = new Set<string>();
  const evalSetsByTask = new Map<string, Set<string>>();

  for (const task of tasks) {
    const taskKey = taskKeyFor(task);
    if (!taskKey) continue;
    taskKeys.add(taskKey);

    for (const cell of task.eval_sets) {
      const evalSet = cell.eval_set.trim();
      if (!evalSet) continue;

      const evalSets = evalSetsByTask.get(taskKey) ?? new Set<string>();
      evalSets.add(evalSet);
      evalSetsByTask.set(taskKey, evalSets);

      const cellId = performanceCellId(taskKey, evalSet);
      const existing = cells.get(cellId);
      if (!existing || shouldReplaceDuplicateCell(existing, cell)) {
        cells.set(cellId, cell);
      }
    }
  }

  return { cells, taskKeys, evalSetsByTask };
}

// Prefer the most complete duplicate. Equal-quality duplicates keep their
// first occurrence, making the choice stable for a stable upstream payload.
function shouldReplaceDuplicateCell(existing: ResultCell, candidate: ResultCell) {
  const completenessDelta = Number(isCellComplete(candidate)) - Number(isCellComplete(existing));
  if (completenessDelta !== 0) return completenessDelta > 0;
  const hasMeanDelta =
    Number(candidate.mean_success_rate != null) - Number(existing.mean_success_rate != null);
  if (hasMeanDelta !== 0) return hasMeanDelta > 0;
  if (candidate.completed_runs !== existing.completed_runs) {
    return candidate.completed_runs > existing.completed_runs;
  }
  return totalEpisodes(candidate) > totalEpisodes(existing);
}

function expectedCellIdsForVariant(
  variant: ResultVariant,
  normalized: NormalizedVariantResults,
  group: ResultGroup,
): Set<string> {
  const configuredTaskKeys = configuredTaskKeysForVariant(variant);
  const configuredEvalSets = configuredEvalSetsForVariant(variant);

  if (configuredTaskKeys.size && configuredEvalSets.size) {
    return cellIdCrossProduct(configuredTaskKeys, configuredEvalSets);
  }

  if (configuredTaskKeys.size) {
    return expectedCellIdsForTaskKeys(configuredTaskKeys, normalized);
  }

  if (configuredEvalSets.size) {
    const taskKeys = normalized.taskKeys.size
      ? normalized.taskKeys
      : TASK_KEYS_BY_GROUP[group];
    return cellIdCrossProduct(taskKeys, configuredEvalSets);
  }

  if (normalized.taskKeys.size) {
    return expectedCellIdsForTaskKeys(normalized.taskKeys, normalized);
  }

  return expectedCellIdsForTaskKeys(TASK_KEYS_BY_GROUP[group], normalized);
}

function expectedCellIdsForTaskKeys(
  taskKeys: Iterable<string>,
  normalized: NormalizedVariantResults,
) {
  const cellIds = new Set<string>();
  for (const taskKey of taskKeys) {
    const catalogEvalSets = TASK_CATALOG_BY_KEY.get(taskKey)?.displayEvalSets;
    const evalSets = catalogEvalSets?.length
      ? catalogEvalSets
      : normalized.evalSetsByTask.get(taskKey) ?? [];
    for (const evalSet of evalSets) {
      cellIds.add(performanceCellId(taskKey, evalSet));
    }
  }
  return cellIds;
}

function cellIdCrossProduct(taskKeys: Iterable<string>, evalSets: Iterable<string>) {
  const cellIds = new Set<string>();
  for (const taskKey of taskKeys) {
    for (const evalSet of evalSets) {
      cellIds.add(performanceCellId(taskKey, evalSet));
    }
  }
  return cellIds;
}

function configuredTaskKeysForVariant(variant: ResultVariant) {
  return new Set(
    (variant.expected_task_keys ?? [])
      .map(taskKeyForText)
      .filter(Boolean),
  );
}

function configuredEvalSetsForVariant(variant: ResultVariant) {
  return new Set(
    (variant.expected_eval_sets ?? [])
      .map((evalSet) => evalSet.trim())
      .filter(Boolean),
  );
}

function isVariantComplete(
  normalized: NormalizedVariantResults,
  expectedCellIds: Iterable<string>,
) {
  for (const cellId of expectedCellIds) {
    const cell = normalized.cells.get(cellId);
    if (!cell || !isCellComplete(cell)) return false;
  }
  return true;
}

function isCellComplete(cell: ResultCell) {
  if (cell.mean_success_rate == null) return false;
  if (cell.expected_runs != null && cell.expected_runs > 0) {
    return cell.completed_runs >= cell.expected_runs;
  }
  return true;
}

function taskKeyFor(task: ResultTask): string {
  const source = `${task.task} ${task.task_name ?? ""}`.toLowerCase();
  const catalogKey = catalogTaskKeyForText(source);
  return catalogKey || normalizeKey(task.task_name || task.task);
}

function taskKeyForText(value: string): string {
  return catalogTaskKeyForText(value) || normalizeKey(value);
}

function catalogTaskKeyForText(value: string): string {
  const source = value.toLowerCase();
  const normalizedSource = normalizeKey(value);
  const task = TASK_CATALOG.find((candidate) =>
    candidate.aliases.some((alias) => (
      source.includes(alias) || normalizedSource.includes(normalizeKey(alias))
    )),
  );
  return task?.key ?? "";
}

function performanceCellId(taskKey: string, evalSet: string) {
  return `${taskKey}::${evalSet}`;
}

function normalizeKey(value: string) {
  return value
    .toLowerCase()
    .replace(/^task-/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function resultGroupForVariant(
  variant: ResultVariant,
  taskKeys: Iterable<string>,
): ResultGroup {
  const text = `${variant.experiment ?? ""} ${variant.variant} ${variant.model_version ?? ""}`.toLowerCase();
  if (text.includes("dexjoco")) return "dexjoco";
  for (const taskKey of taskKeys) {
    if (TASK_CATALOG_BY_KEY.get(taskKey)?.group === "dexjoco") return "dexjoco";
  }
  return "main";
}

function formatTokenCount(value?: number | null) {
  return value == null ? "" : String(value);
}

function formatCompletedAt(seconds?: number | null) {
  if (seconds == null) return "";
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}`;
  } catch {
    return "";
  }
}

function formatMeanStd(cell: ResultCell) {
  if (cell.mean_success_rate == null) return "";
  return `${formatPct(cell.mean_success_rate)} ± ${formatPct(cell.std_success_rate ?? 0)}`;
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function totalEpisodes(cell: ResultCell) {
  return cell.episode_counts.reduce<number>(
    (total, count) => total + (count != null && count > 0 ? count : 0),
    0,
  );
}

function totalWeightedAverage(
  cells: ReadonlyMap<string, ResultCell>,
  cellIds: Iterable<string>,
) {
  let successes = 0;
  let episodes = 0;

  for (const cellId of cellIds) {
    const cell = cells.get(cellId);
    if (!cell) continue;
    cell.episode_counts.forEach((episodeCount, idx) => {
      if (episodeCount == null || episodeCount <= 0) return;
      const successCount = cell.success_counts[idx];
      if (successCount != null) {
        episodes += episodeCount;
        successes += successCount;
        return;
      }
      const runRate = cell.per_run_success_rate[idx];
      if (runRate == null) return;
      episodes += episodeCount;
      successes += runRate * episodeCount;
    });
  }

  return episodes > 0 ? successes / episodes : null;
}
