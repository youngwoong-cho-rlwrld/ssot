import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_CONFIG_BYTES = 1_000_000;
const MAX_CONFIG_CACHE_ENTRIES = 512;
const SAFE_VARIANT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254}[A-Za-z0-9])?$/;

type ExperimentConfig = {
  stateTokenCount: number | null;
  actionTokenCount: number | null;
  expectedTaskKeys: string[];
  expectedEvalSets: string[];
};

type ConfigCacheEntry = {
  mtimeMs: number;
  size: number;
  config: ExperimentConfig;
};

type JsonRecord = Record<string, unknown>;

const configCache = new Map<string, ConfigCacheEntry>();

export function resultsConfigsRoot(override?: string | null) {
  const configured =
    normalizeConfigsRootOverride(override) ??
    process.env.RESULTS_CONFIGS_ROOT ??
    "../train-eval/configs/experiments";
  return path.resolve(process.cwd(), configured);
}

// A per-request override (the x-ssot-results-configs-root gateway header) is
// resolved against cwd exactly like RESULTS_CONFIGS_ROOT. Blank values and
// values containing a NUL byte are rejected so a malformed header falls back to
// the configured default; per-variant traversal below stays guarded by
// isPathInside regardless of which root is chosen.
function normalizeConfigsRootOverride(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  return trimmed;
}

export async function enrichResultsPayloadWithConfigs<T extends { variants?: unknown[] }>(
  payload: T,
  configsRoot = resultsConfigsRoot(),
): Promise<T> {
  if (!Array.isArray(payload.variants)) return payload;

  const variants = await Promise.all(
    payload.variants.map((variant) => enrichVariant(variant, configsRoot)),
  );
  return { ...payload, variants };
}

async function enrichVariant(input: unknown, configsRoot: string): Promise<unknown> {
  if (!isRecord(input) || typeof input.variant !== "string") return input;

  const config = await readExperimentConfig(input.variant, configsRoot);
  const defaultState = defaultStateTokenCount(input.variant);
  const defaultAction = defaultActionTokenCount(input.variant);
  if (!config && defaultState == null && defaultAction == null) return input;

  return {
    ...input,
    state_token_count: nonnegativeInteger(input.state_token_count) ?? config?.stateTokenCount ?? defaultState,
    action_token_count: nonnegativeInteger(input.action_token_count) ?? config?.actionTokenCount ?? defaultAction,
    expected_task_keys: stringArray(input.expected_task_keys, config?.expectedTaskKeys ?? []),
    expected_eval_sets: stringArray(input.expected_eval_sets, config?.expectedEvalSets ?? []),
  };
}

async function readExperimentConfig(
  variant: string,
  configsRoot: string,
): Promise<ExperimentConfig | null> {
  if (!SAFE_VARIANT.test(variant)) return null;

  const configPath = path.join(configsRoot, variant, "config.sh");
  if (!isPathInside(configsRoot, configPath)) return null;

  let metadata;
  try {
    metadata = await stat(configPath);
  } catch {
    return null;
  }
  if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) return null;

  const cached = configCache.get(configPath);
  if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) {
    touchCache(configPath, cached);
    return cached.config;
  }

  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return null;
  }

  const config = parseExperimentConfigText(text);
  touchCache(configPath, { mtimeMs: metadata.mtimeMs, size: metadata.size, config });
  trimCache();
  return config;
}

export function parseExperimentConfigText(text: string): ExperimentConfig {
  const trainExtraArgs = parseShellArray(text, "TRAIN_EXTRA_ARGS");
  const tasks = parseShellArray(text, "TASKS");
  const dexjocoTask = parseShellScalar(text, "DEXJOCO_TASK");
  const taskName = parseShellScalar(text, "TASK_NAME");

  return {
    stateTokenCount: numberArgAfter(trainExtraArgs, "--state-part-token-count"),
    actionTokenCount: numberArgAfter(trainExtraArgs, "--action-part-token-count"),
    expectedTaskKeys: expectedTaskKeys(tasks, dexjocoTask, taskName),
    expectedEvalSets: unique(parseShellArray(text, "EVAL_SETS")),
  };
}

function parseShellArray(text: string, name: string) {
  const body = extractShellArrayBody(text, name);
  return body == null ? [] : shellWords(body);
}

function parseShellScalar(text: string, name: string) {
  const match = text.match(new RegExp(`(?:^|\\n)\\s*${name}\\s*=\\s*([^\\n]+)`));
  return match ? shellWords(match[1] ?? "")[0] ?? "" : "";
}

function extractShellArrayBody(text: string, name: string): string | null {
  const match = text.match(new RegExp(`(?:^|\\n)\\s*${name}\\s*=\\s*\\(`));
  if (!match || match.index == null) return null;

  const bodyStart = match.index + match[0].length;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = bodyStart; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if ((character === "'" || character === '"') && !quote) {
      quote = character;
    } else if (character === quote) {
      quote = null;
    } else if (character === ")" && !quote) {
      return text.slice(bodyStart, index);
    }
  }
  return text.slice(bodyStart);
}

function shellWords(text: string) {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if ((character === "'" || character === '"') && !quote) {
      quote = character;
    } else if (character === quote) {
      quote = null;
    } else if (character === "#" && !quote) {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (/\s/.test(character) && !quote) {
      if (current) words.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  if (current) words.push(current);
  return words;
}

function expectedTaskKeys(tasks: string[], dexjocoTask: string, taskName: string) {
  if (tasks.length) {
    return unique(tasks.map((entry) => {
      const [rawShortName, configuredTaskName] = entry.split("|", 2);
      const shortName = rawShortName ?? "";
      return shortName === "__single__" ? configuredTaskName || shortName : shortName;
    }).filter((value): value is string => Boolean(value)));
  }
  return unique([dexjocoTask, taskName].filter(Boolean));
}

function numberArgAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return nonnegativeInteger(Number(args[index + 1]));
}

function defaultStateTokenCount(variant: string) {
  return startsWithAny(variant, ["action_horizon_ablation", "batch_size_ablation"]) ? 1 : null;
}

function defaultActionTokenCount(variant: string) {
  return includesAny(variant, [
    "poc1",
    "heuristic",
    "discrete_mi",
    "action_horizon_ablation",
    "batch_size_ablation",
  ]) ? 1 : null;
}

function startsWithAny(value: string, prefixes: string[]) {
  const normalized = value.toLowerCase();
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

function includesAny(value: string, needles: string[]) {
  const normalized = value.toLowerCase();
  return needles.some((needle) => normalized.includes(needle));
}

function stringArray(input: unknown, fallback: string[]) {
  if (!Array.isArray(input)) return [...fallback];
  const values = input.filter((value): value is string => typeof value === "string" && Boolean(value));
  return values.length ? unique(values) : [...fallback];
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isPathInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function touchCache(configPath: string, entry: ConfigCacheEntry) {
  configCache.delete(configPath);
  configCache.set(configPath, entry);
}

function trimCache() {
  while (configCache.size > MAX_CONFIG_CACHE_ENTRIES) {
    const oldest = configCache.keys().next().value;
    if (oldest === undefined) break;
    configCache.delete(oldest);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
