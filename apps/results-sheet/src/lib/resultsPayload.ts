import type {
  ResultCell,
  ResultTask,
  ResultVariant,
  ResultsResponse,
} from "./results.ts";
import { isValidClusterName } from "./clusters.ts";

type JsonRecord = Record<string, unknown>;

const PAYLOAD_LIMITS = {
  variants: 10_000,
  tasksPerVariant: 128,
  cellsPerTask: 128,
  errors: 128,
  strings: 512,
  stringArrayItems: 256,
  runsPerCell: 1_000,
} as const;
const MAX_DATE_SECONDS = 8_640_000_000_000;

export function normalizeResultsPayload(
  input: unknown,
  expectedCluster?: string,
): ResultsResponse {
  const payload = isRecord(input) ? input : {};
  const normalizedExpectedCluster = clusterName(expectedCluster);
  const variants = Array.isArray(payload.variants)
    ? payload.variants.slice(0, PAYLOAD_LIMITS.variants)
        .map(normalizeVariant)
        .filter((variant): variant is ResultVariant => (
          variant !== null &&
          (!normalizedExpectedCluster || variant.cluster === normalizedExpectedCluster)
        ))
    : [];
  const errors = Array.isArray(payload.errors)
    ? payload.errors.slice(0, PAYLOAD_LIMITS.errors)
        .map(normalizeResultError)
        .filter((error): error is ResultsResponse["errors"][number] => (
          error !== null &&
          (!normalizedExpectedCluster || error.cluster === normalizedExpectedCluster)
        ))
    : [];

  return { variants, errors };
}

function normalizeVariant(input: unknown): ResultVariant | null {
  if (!isRecord(input) || !Array.isArray(input.tasks)) return null;

  const cluster = clusterName(input.cluster);
  const variant = requiredString(input.variant);
  if (!cluster || !variant) return null;

  return {
    cluster,
    variant,
    job_id: nullableString(input.job_id),
    job_name: nullableString(input.job_name),
    experiment: nullableString(input.experiment),
    model_version: nullableString(input.model_version),
    checkpoint: nullableString(input.checkpoint),
    state_token_count: nullableNonnegativeInteger(input.state_token_count),
    action_token_count: nullableNonnegativeInteger(input.action_token_count),
    expected_task_keys: stringArray(input.expected_task_keys),
    expected_eval_sets: stringArray(input.expected_eval_sets),
    source: nullableString(input.source),
    completed_at: nullableCompletedAt(input.completed_at),
    tasks: input.tasks.slice(0, PAYLOAD_LIMITS.tasksPerVariant)
      .map(normalizeTask)
      .filter((task): task is ResultTask => task !== null),
  };
}

function normalizeTask(input: unknown): ResultTask | null {
  if (!isRecord(input) || !Array.isArray(input.eval_sets)) return null;

  const task = requiredString(input.task);
  if (!task) return null;

  return {
    task,
    task_name: nullableString(input.task_name),
    eval_sets: input.eval_sets.slice(0, PAYLOAD_LIMITS.cellsPerTask)
      .map(normalizeCell)
      .filter((cell): cell is ResultCell => cell !== null),
  };
}

function normalizeCell(input: unknown): ResultCell | null {
  if (
    !isRecord(input) ||
    !Array.isArray(input.per_run_success_rate) ||
    !Array.isArray(input.success_counts) ||
    !Array.isArray(input.episode_counts)
  ) {
    return null;
  }

  const evalSet = requiredString(input.eval_set);
  const completedRuns = nonnegativeInteger(input.completed_runs);
  if (!evalSet || completedRuns == null) return null;

  const runArrays = normalizeRunArrays(
    input.per_run_success_rate,
    input.success_counts,
    input.episode_counts,
  );

  return {
    eval_set: evalSet,
    mean_success_rate: nullableRate(input.mean_success_rate),
    std_success_rate: nullableNonnegativeNumber(input.std_success_rate),
    per_run_success_rate: runArrays.rates,
    success_counts: runArrays.successCounts,
    episode_counts: runArrays.episodeCounts,
    completed_runs: completedRuns,
    expected_runs: nullableNonnegativeInteger(input.expected_runs),
  };
}

function normalizeRunArrays(
  rawRates: unknown[],
  rawSuccessCounts: unknown[],
  rawEpisodeCounts: unknown[],
) {
  const rates: number[] = [];
  const successCounts: Array<number | null> = [];
  const episodeCounts: Array<number | null> = [];
  const length = Math.min(PAYLOAD_LIMITS.runsPerCell, Math.max(
    rawRates.length,
    rawSuccessCounts.length,
    rawEpisodeCounts.length,
  ));

  for (let index = 0; index < length; index += 1) {
    const episodeCount = nullableNonnegativeInteger(rawEpisodeCounts[index]);
    let successCount = nullableNonnegativeInteger(rawSuccessCounts[index]);
    if (
      successCount != null &&
      episodeCount != null &&
      successCount > episodeCount
    ) {
      successCount = null;
    }

    let rate = nullableRate(rawRates[index]);
    if (
      rate == null &&
      successCount != null &&
      episodeCount != null &&
      episodeCount > 0
    ) {
      rate = successCount / episodeCount;
    }

    // Every retained run has a usable rate, which keeps the three arrays
    // aligned without inventing placeholders for malformed values.
    if (rate == null) continue;
    rates.push(rate);
    successCounts.push(successCount);
    episodeCounts.push(episodeCount);
  }

  return { rates, successCounts, episodeCounts };
}

function normalizeResultError(
  input: unknown,
): ResultsResponse["errors"][number] | null {
  if (!isRecord(input)) return null;
  const cluster = clusterName(input.cluster);
  const error = requiredString(input.error);
  return cluster && error ? { cluster, error } : null;
}

function stringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const values = input
    .slice(0, PAYLOAD_LIMITS.stringArrayItems)
    .map(requiredString)
    .filter((value): value is string => value !== null);
  return Array.from(new Set(values));
}

function requiredString(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  return value && value.length <= PAYLOAD_LIMITS.strings ? value : null;
}

function clusterName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  return isValidClusterName(value) ? value : null;
}

function nullableString(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  return value && value.length <= PAYLOAD_LIMITS.strings ? value : null;
}

function nullableRate(input: unknown): number | null {
  return typeof input === "number" && Number.isFinite(input) && input >= 0 && input <= 1
    ? input
    : null;
}

function nonnegativeInteger(input: unknown): number | null {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0
    ? input
    : null;
}

function nullableNonnegativeInteger(input: unknown): number | null {
  return input == null ? null : nonnegativeInteger(input);
}

function nullableNonnegativeNumber(input: unknown): number | null {
  return typeof input === "number" && Number.isFinite(input) && input >= 0
    ? input
    : null;
}

function nullableCompletedAt(input: unknown): number | null {
  const value = nullableNonnegativeNumber(input);
  return value != null && value <= MAX_DATE_SECONDS ? value : null;
}

function isRecord(input: unknown): input is JsonRecord {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
