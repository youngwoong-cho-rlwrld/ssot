import {
  CHART_GROUP_MODES,
  CHART_TYPES,
  DEFAULT_CHART_GROUP_MODE,
  DEFAULT_CHART_TYPE,
  TASK_CHART_GROUP_MODES,
} from "./agentContract.mjs";

export {
  CHART_GROUP_MODES,
  CHART_TYPES,
  DEFAULT_CHART_GROUP_MODE,
  DEFAULT_CHART_TYPE,
  TASK_CHART_GROUP_MODES,
};

export type ChartType = (typeof CHART_TYPES)[number];

export type ChartGroupMode = (typeof CHART_GROUP_MODES)[number];

export type TaskChartGroupMode = (typeof TASK_CHART_GROUP_MODES)[number];

export type ChartGroupOverrides = Record<string, TaskChartGroupMode>;

export function isChartType(value: string): value is ChartType {
  return CHART_TYPES.some((chartType) => chartType === value);
}

export function isChartGroupMode(value: string): value is ChartGroupMode {
  return CHART_GROUP_MODES.some((mode) => mode === value);
}

export function isTaskChartGroupMode(value: string): value is TaskChartGroupMode {
  return TASK_CHART_GROUP_MODES.some((mode) => mode === value);
}

// Effective grouping for one task chart: an explicit per-task override wins,
// then a non-auto global mode; auto groups multi-eval-set tasks by eval set
// and single-eval-set tasks (e.g. DexJoCo) by experiment.
export function resolveTaskGroupBy(
  groupBy: ChartGroupMode,
  overrides: ChartGroupOverrides,
  taskKey: string,
  evalSetCount: number,
): TaskChartGroupMode {
  const override = overrides[taskKey];
  if (override) return override;
  if (groupBy !== "auto") return groupBy;
  return evalSetCount > 1 ? "evalSet" : "experiment";
}
