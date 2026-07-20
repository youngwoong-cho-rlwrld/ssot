import type { Field } from "../enmight/types/apiTypes.ts";
import type { ColorStylerItemType, RowType, SortByItemType } from "../enmight/types/layoutTypes.ts";
import { GROUP_RANK, type PerformanceColumn, type SheetRow } from "./results.ts";
import { createTableColorResolver, DEFAULT_TABLE_COLOR } from "./tableColors.ts";

export type ChartTaskDescriptor = {
  taskKey: string;
  label: string;
  evalSets: string[];
};

type ChartCell = {
  value: number | null;
  display: string;
  color: string;
};

export type ChartRow = {
  id: string;
  experiment: string;
  values: Record<string, Record<string, ChartCell>>;
};

export function sortSheetRows(rows: SheetRow[], sortRules: SortByItemType[]): SheetRow[] {
  const activeRules = sortRules.filter((rule): rule is SortByItemType & {
    fieldId: string;
    sortState: "asc" | "desc";
  } => Boolean(rule.fieldId && rule.sortState));
  if (!activeRules.length) return rows;

  return [...rows].sort((left, right) => {
    const groupDelta = GROUP_RANK[left.group] - GROUP_RANK[right.group];
    if (groupDelta) return groupDelta;
    for (const rule of activeRules) {
      const comparison = compareSortValues(
        sortValueForField(left, rule.fieldId),
        sortValueForField(right, rule.fieldId),
        rule.sortState,
      );
      if (comparison) return comparison;
    }
    return left.variant.localeCompare(right.variant, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function sortValueForField(row: SheetRow, fieldId: string): string | number | null {
  if (fieldId === "completed") return row.completedSort;
  if (fieldId === "stateTokens") return row.stateTokenSort;
  if (fieldId === "actionTokens") return row.actionTokenSort;
  if (fieldId === "totalAverage") return row.totalAverageValue;
  if (fieldId in row.metrics) return row.metrics[fieldId]?.value ?? null;
  const value = row[fieldId as keyof SheetRow];
  if (typeof value === "number" || typeof value === "string") return value;
  return null;
}

function compareSortValues(
  left: string | number | null,
  right: string | number | null,
  direction: "asc" | "desc",
): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  const comparison = typeof left === "number" && typeof right === "number"
    ? left - right
    : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
  return direction === "desc" ? -comparison : comparison;
}

export function buildTableHeaders(performanceColumns: PerformanceColumn[]): Field[] {
  return [
    { id: "experiment", displayName: "Experiments", type: "TEXT" },
    { id: "variant", displayName: "Jobs", type: "TEXT" },
    { id: "completed", displayName: "Eval completed", type: "DATETIME" },
    { id: "stateTokens", displayName: "state token 수", type: "NUMBER" },
    { id: "actionTokens", displayName: "action token 수", type: "NUMBER" },
    { id: "stateEncoder", displayName: "State Encoder 방식", type: "TEXT" },
    { id: "actionEncoder", displayName: "Action Encoder 방식", type: "TEXT" },
    { id: "totalAverage", displayName: "Total average", type: "TEXT" },
    ...performanceColumns.map<Field>((column) => ({
      id: column.id,
      displayName: column.label,
      type: "TEXT",
    })),
  ];
}

export function buildTableRows(rows: SheetRow[], performanceColumns: PerformanceColumn[]): RowType[] {
  return rows.map((row) => {
    const tableRow: RowType = {
      id: row.id,
      experiment: row.experiment,
      variant: row.variant,
      completed: row.completed,
      stateTokens: row.stateTokens,
      actionTokens: row.actionTokens,
      stateEncoder: row.stateEncoder,
      actionEncoder: row.actionEncoder,
      totalAverage: row.totalAverage,
      __rowBold: row.id === "baseline-average",
    };
    for (const column of performanceColumns) {
      tableRow[column.id] = row.metrics[column.id]?.display ?? "";
    }
    return tableRow;
  });
}

export function buildChartTasks(
  performanceColumns: PerformanceColumn[],
  rows: SheetRow[],
): ChartTaskDescriptor[] {
  const byTask = new Map<string, { label: string; evalSets: string[] }>();
  for (const column of performanceColumns) {
    if (!rows.some((row) => row.metrics[column.id]?.value != null)) continue;
    const task = byTask.get(column.taskKey) ?? { label: taskLabel(column), evalSets: [] };
    if (!task.evalSets.includes(column.evalSet)) task.evalSets.push(column.evalSet);
    byTask.set(column.taskKey, task);
  }
  return [...byTask].map(([taskKey, task]) => ({ taskKey, ...task }));
}

export function buildChartRows(
  rows: SheetRow[],
  tableRows: RowType[],
  headers: Field[],
  performanceColumns: PerformanceColumn[],
  colorRules: ColorStylerItemType[],
): ChartRow[] {
  const tableRowsById = new Map(tableRows.map((row) => [row.id, row]));
  const headersById = new Map(headers.map((header) => [header.id, header]));
  const resolveColor = createTableColorResolver(colorRules);
  return rows.map((row) => {
    const tableRow = tableRowsById.get(row.id);
    const values: ChartRow["values"] = {};
    for (const column of performanceColumns) {
      const header = headersById.get(column.id);
      const color = tableRow && header
        ? resolveColor(header, tableRow)
        : undefined;
      const taskValues = values[column.taskKey] ??= {};
      taskValues[column.evalSet] = {
        value: row.metrics[column.id]?.value ?? null,
        display: row.metrics[column.id]?.display ?? "",
        color: color ?? DEFAULT_TABLE_COLOR,
      };
    }
    return { id: row.id, experiment: row.experiment, values };
  });
}

export function buildAgentRowContext(row: SheetRow, performanceColumns: PerformanceColumn[]) {
  const metrics: Record<string, string> = {};
  for (const column of performanceColumns) {
    const display = row.metrics[column.id]?.display ?? "";
    if (display) metrics[column.id] = display;
  }
  return {
    id: row.id,
    experiment: row.experiment,
    job: row.variant,
    evalCompleted: row.completed,
    stateTokens: row.stateTokens,
    actionTokens: row.actionTokens,
    stateEncoder: row.stateEncoder,
    actionEncoder: row.actionEncoder,
    totalAverage: row.totalAverage,
    metrics,
  };
}

export function buildAgentRowsContext(
  rowsInCurrentOrder: SheetRow[],
  allRowsInCurrentOrder: SheetRow[],
  performanceColumns: PerformanceColumn[],
) {
  const rows = new Map<string, ReturnType<typeof buildAgentRowContext>>();
  for (const row of [...rowsInCurrentOrder, ...allRowsInCurrentOrder]) {
    if (!rows.has(row.id)) {
      rows.set(row.id, buildAgentRowContext(row, performanceColumns));
    }
  }
  return {
    rows: [...rows.values()],
    rowIdsInCurrentOrder: rowsInCurrentOrder.map((row) => row.id),
    allRowIdsInCurrentOrder: allRowsInCurrentOrder.map((row) => row.id),
  };
}

function taskLabel(column: PerformanceColumn) {
  const suffix = ` ${column.evalSet}`;
  return column.label.endsWith(suffix) ? column.label.slice(0, -suffix.length) : column.label;
}
