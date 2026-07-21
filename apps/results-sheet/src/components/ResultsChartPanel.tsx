"use client";

import { IconChevronDown, IconChevronUp, IconX } from "@tabler/icons-react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Bar, type BarItemProps, type ComputedDatum as BarComputedDatum } from "@nivo/bar";
import { Line } from "@nivo/line";
import { Radar } from "@nivo/radar";
import { HeatMap, type CellComponentProps } from "@nivo/heatmap";
import {
  CHART_TYPES,
  resolveTaskGroupBy,
  type ChartGroupMode,
  type ChartGroupOverrides,
  type ChartType,
  type TaskChartGroupMode,
} from "@/lib/chartTypes";
import type { ChartRow, ChartTaskDescriptor } from "@/lib/sheetView";
import { DEFAULT_TABLE_COLOR } from "@/lib/tableColors";
import { PanelResizeHandle } from "@/components/PanelResizeHandle";
import { SsotSelect, type SsotSelectOption } from "@ssot/ui/SsotSelect";

type ResultsChartPanelProps = {
  width: number;
  minWidth: number;
  maxWidth: number;
  tasks: ChartTaskDescriptor[];
  rows: ChartRow[];
  chartType: ChartType;
  groupBy: ChartGroupMode;
  groupOverrides: ChartGroupOverrides;
  onChartTypeChange: (chartType: ChartType) => void;
  onGroupByChange: (groupBy: ChartGroupMode) => void;
  onTaskGroupByChange: (taskKey: string, groupBy: ChartGroupMode) => void;
  onClose: () => void;
  onResizeStart: (event: PointerEvent<HTMLButtonElement>) => void;
  onResizeBy: (deltaWidth: number) => void;
  onHoverRow: (rowId: string | null) => void;
  onToggleRow: (rowId: string) => void;
  hoveredRowId: string | null;
  selectedRowIds: ReadonlySet<string>;
};

// One entry on a chart axis: an eval set (rowId "") or an experiment row.
type ChartAxisItem = {
  key: string;
  label: string;
  rowId: string;
};

// A task chart as group x series: `groups` index the chart (bar clusters,
// line/heatmap x, radar spokes) and `seriesItems` color within a group. One
// side is always the task's eval sets and the other the evaluated rows.
type TaskChartMatrix = {
  groupMode: TaskChartGroupMode;
  groups: ChartAxisItem[];
  seriesItems: ChartAxisItem[];
  cellFor: (group: ChartAxisItem, series: ChartAxisItem) => ChartCellValue | undefined;
  rowIdFor: (group: ChartAxisItem, series: ChartAxisItem) => string;
};

type ChartCellValue = ChartRow["values"][string][string];

type ExperimentLabels = {
  labelByRowId: Record<string, string>;
  rowIdByLabel: Record<string, string>;
};

type ChartTooltipApi = {
  show: (content: ReactNode) => void;
  hide: () => void;
};

const ChartTooltipContext = createContext<ChartTooltipApi>({
  show: () => {},
  hide: () => {},
});

// Nivo renders tooltips inside the chart container, so the scroller's
// overflow clips them at the panel edges. Render ours through a body portal
// that follows the cursor and clamps to the viewport instead.
function ChartTooltipProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const cursorRef = useRef({ x: 0, y: 0 });
  const visibleRef = useRef(false);

  const hide = useCallback(() => {
    visibleRef.current = false;
    setContent(null);
  }, []);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      cursorRef.current = { x: event.clientX, y: event.clientY };
      if (!visibleRef.current) return;
      // Single source of truth for dismissal: the tooltip lives only while the
      // pointer is really over the chart body. Per-mark mouseleave is
      // unreliable here — a hover-driven re-render swaps nivo's mark nodes and
      // the node that owed the leave is destroyed before firing it, stranding
      // the tooltip. Hit-testing the live pointer survives that and covers
      // every chart type uniformly. (.chartTooltipFloat is pointer-events:none,
      // so it never occludes the element below.)
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!target?.closest(".chartPanelBody")) {
        hide();
        return;
      }
      setPosition(cursorRef.current);
    };
    window.addEventListener("mousemove", handleMove);
    return () => window.removeEventListener("mousemove", handleMove);
  }, [hide]);

  const api = useMemo<ChartTooltipApi>(() => ({
    show: (next) => {
      visibleRef.current = true;
      setPosition(cursorRef.current);
      setContent(next);
    },
    hide,
  }), [hide]);

  return (
    <ChartTooltipContext.Provider value={api}>
      {children}
      {content != null && typeof document !== "undefined"
        ? createPortal(
            <FloatingChartTooltip position={position}>{content}</FloatingChartTooltip>,
            document.body,
          )
        : null}
    </ChartTooltipContext.Provider>
  );
}

function FloatingChartTooltip({
  position,
  children,
}: {
  position: { x: number; y: number };
  children: ReactNode;
}) {
  const flipX = position.x > window.innerWidth - 300;
  const flipY = position.y > window.innerHeight - 200;
  const style: CSSProperties = {
    left: position.x + (flipX ? -14 : 14),
    top: position.y + (flipY ? -14 : 14),
    transform: `translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`,
  };
  return (
    <div className="chartTooltipFloat" style={style}>
      {children}
    </div>
  );
}

type ChartStat = {
  experiment: string;
  display: string;
};

type TaskBarDatum = {
  group: string;
  colors: Record<string, string>;
  stats: Record<string, ChartStat>;
  rowIds: Record<string, string>;
  [key: string]:
    | string
    | number
    | null
    | Record<string, string>
    | Record<string, ChartStat>;
};

const BAR_WIDTH = 12;
const AXIS_WIDTH = 48;
const CHART_HEIGHT = 190;
const ROTATED_TICKS_HEIGHT = 56;
const ROTATED_TICKS_BOTTOM_MARGIN = 84;
const HEATMAP_ROW_HEIGHT = 28;
const HEATMAP_MIN_COL_WIDTH = 56;
// Approximate width of one label character at the 11px axis font, used to
// size label gutters so long experiment names are not clipped at the edges.
const LABEL_CHAR_WIDTH = 6.5;
const DEFAULT_CELL_COLOR = DEFAULT_TABLE_COLOR;
const Y_TICKS = [0, 25, 50, 75, 100];

// Categorical fallback palette for series whose cell color is still the default.
const FALLBACK_SERIES_COLORS = [
  "#4c78a8",
  "#f58518",
  "#54a24b",
  "#e45756",
  "#72b7b2",
  "#b279a2",
  "#ff9da6",
  "#9d755d",
  "#bab0ac",
  "#eeca3b",
];

const CHART_TYPE_LABELS: Record<ChartType, string> = {
  bar: "Bar",
  line: "Line",
  radar: "Radar",
  heatmap: "Heatmap",
};

const CHART_GROUP_LABELS: Record<Exclude<ChartGroupMode, "auto">, string> = {
  evalSet: "Eval set",
  experiment: "Experiment",
};

// Option lists for the canonical SsotSelect dropdowns (chart-panel and per-task
// grouping, chart type). The per-task list labels "auto" as "Default" since it
// inherits the panel-level grouping.
const CHART_GROUP_SELECT_OPTIONS: SsotSelectOption[] = [
  { value: "auto", label: "Group: Auto" },
  { value: "evalSet", label: `Group: ${CHART_GROUP_LABELS.evalSet}` },
  { value: "experiment", label: `Group: ${CHART_GROUP_LABELS.experiment}` },
];

const TASK_GROUP_SELECT_OPTIONS: SsotSelectOption[] = [
  { value: "auto", label: "Group: Default" },
  { value: "evalSet", label: `Group: ${CHART_GROUP_LABELS.evalSet}` },
  { value: "experiment", label: `Group: ${CHART_GROUP_LABELS.experiment}` },
];

const CHART_TYPE_SELECT_OPTIONS: SsotSelectOption[] = CHART_TYPES.map((type) => ({
  value: type,
  label: CHART_TYPE_LABELS[type],
}));

const CHART_THEME = {
  text: { fontFamily: "inherit", fontSize: 11, fill: "var(--text-secondary)" },
  axis: {
    domain: { line: { stroke: "var(--border-subtle-2)" } },
    ticks: {
      line: { stroke: "var(--border-subtle-2)" },
      text: { fill: "var(--text-secondary)", fontSize: 11 },
    },
    legend: { text: { fill: "var(--text-secondary)" } },
  },
  grid: { line: { stroke: "var(--border-subtle)", strokeDasharray: "3 3" } },
  tooltip: {
    container: { background: "transparent", boxShadow: "none", padding: 0 },
  },
};

const MIN_CHART_WIDTH = 360;
// Percent y-axis shared by bar and line; base bottom axis shared by all.
const PERCENT_AXIS_LEFT = {
  tickSize: 0,
  tickPadding: 6,
  tickValues: Y_TICKS,
  format: (value: number) => `${value}%`,
};
const AXIS_BOTTOM_BASE = { tickSize: 0, tickPadding: 6 };

// Percent value of a cell (0..1 fraction → 0..100), or nullAs when unevaluated.
function chartCellPercent(
  cell: ChartCellValue | undefined,
  nullAs: number | null,
): number | null {
  const value = cell?.value;
  return value == null ? nullAs : value * 100;
}

// Width of a label gutter sized to the longest experiment label, clamped so
// charts can neither clip names nor let the gutter dominate.
function labelGutter(
  maxLabelChars: number,
  { pad = 0, scale = 1, min = 0, max }: { pad?: number; scale?: number; min?: number; max: number },
): number {
  const raw = Math.ceil(pad + maxLabelChars * LABEL_CHAR_WIDTH * scale);
  return Math.min(max, Math.max(min, raw));
}

function rowIdFromLabel(label: unknown, labels: ExperimentLabels): string {
  return labels.rowIdByLabel[String(label ?? "")] ?? "";
}

function seriesColor(index: number): string {
  return FALLBACK_SERIES_COLORS[index % FALLBACK_SERIES_COLORS.length] ?? "#4c78a8";
}

export function ResultsChartPanel({
  width,
  minWidth,
  maxWidth,
  tasks,
  rows,
  chartType,
  groupBy,
  groupOverrides,
  onChartTypeChange,
  onGroupByChange,
  onTaskGroupByChange,
  onClose,
  onResizeStart,
  onResizeBy,
  onHoverRow,
  onToggleRow,
  hoveredRowId,
  selectedRowIds,
}: ResultsChartPanelProps) {
  const chipListRef = useRef<HTMLDivElement>(null);
  const [chipsExpanded, setChipsExpanded] = useState(false);
  const [chipsOverflowing, setChipsOverflowing] = useState(false);
  const labels = useMemo(() => shortExperimentLabels(rows), [rows]);

  useEffect(() => {
    const chipList = chipListRef.current;
    if (!chipList) return;

    const measure = () => {
      const chips = Array.from(chipList.children) as HTMLElement[];
      const firstTop = chips[0]?.offsetTop ?? 0;
      setChipsOverflowing(chips.some((chip) => chip.offsetTop > firstTop));
    };

    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(chipList);
    return () => resizeObserver.disconnect();
  }, [rows]);

  const panelStyle = {
    "--panel-width": `${width}px`,
    "--panel-min-width": `${minWidth}px`,
    "--panel-max-width": `${maxWidth}px`,
  } as CSSProperties;

  return (
    <aside
      className={hoveredRowId || selectedRowIds.size ? "chartPanel resultSyncHasActive" : "chartPanel"}
      style={panelStyle}
      aria-label="Filtered success rate chart"
    >
      <PanelResizeHandle
        side="left"
        label="Resize chart panel"
        value={width}
        min={minWidth}
        max={maxWidth}
        onPointerDown={onResizeStart}
        onResizeBy={onResizeBy}
      />
      <div className="chartPanelHeader">
        <div className="chartChipArea">
          <div
            ref={chipListRef}
            className={chipsExpanded ? "chartChipList chartChipListExpanded" : "chartChipList"}
          >
            {rows.map((row) => (
              <button
                key={row.id}
                className={interactionClass("chartChip resultSyncChip", row.id, hoveredRowId, selectedRowIds)}
                data-result-row-id={row.id}
                type="button"
                aria-pressed={selectedRowIds.has(row.id)}
                title={row.experiment}
                onClick={() => onToggleRow(row.id)}
                onMouseEnter={() => onHoverRow(row.id)}
                onMouseLeave={() => onHoverRow(null)}
                onFocus={() => onHoverRow(row.id)}
                onBlur={() => onHoverRow(null)}
              >
                {row.experiment}
              </button>
            ))}
          </div>
        </div>
        {chipsOverflowing && (
          <button
            className="chartChipToggle"
            type="button"
            aria-label={chipsExpanded ? "Collapse experiment list" : "Expand experiment list"}
            title={chipsExpanded ? "Collapse" : "Expand"}
            onClick={() => setChipsExpanded((expanded) => !expanded)}
          >
            {chipsExpanded ? (
              <IconChevronUp size={16} stroke={1.4} aria-hidden="true" />
            ) : (
              <IconChevronDown size={16} stroke={1.4} aria-hidden="true" />
            )}
          </button>
        )}
        <SsotSelect
          className="compactSelect"
          aria-label="Chart grouping"
          value={groupBy}
          options={CHART_GROUP_SELECT_OPTIONS}
          onChange={(value) => onGroupByChange(value as ChartGroupMode)}
        />
        <SsotSelect
          className="compactSelect"
          aria-label="Chart type"
          value={chartType}
          options={CHART_TYPE_SELECT_OPTIONS}
          onChange={(value) => onChartTypeChange(value as ChartType)}
        />
        <button
          className="chartPanelClose"
          type="button"
          onClick={onClose}
          aria-label="Close chart panel"
        >
          <IconX size={18} stroke={1.4} aria-hidden="true" />
        </button>
      </div>
      <ChartTooltipProvider>
        <div className="chartPanelBody">
          {tasks.map((task) => (
            <TaskChart
              key={task.taskKey}
              task={task}
              rows={rows}
              chartType={chartType}
              groupMode={resolveTaskGroupBy(groupBy, groupOverrides, task.taskKey, task.evalSets.length)}
              groupOverride={groupOverrides[task.taskKey] ?? "auto"}
              onTaskGroupByChange={onTaskGroupByChange}
              labels={labels}
              onHoverRow={onHoverRow}
              onToggleRow={onToggleRow}
              hoveredRowId={hoveredRowId}
              selectedRowIds={selectedRowIds}
            />
          ))}
        </div>
      </ChartTooltipProvider>
    </aside>
  );
}

const TaskChart = memo(function TaskChart({
  task,
  rows,
  chartType,
  groupMode,
  groupOverride,
  onTaskGroupByChange,
  labels,
  onHoverRow,
  onToggleRow,
  hoveredRowId,
  selectedRowIds,
}: {
  task: ChartTaskDescriptor;
  rows: ChartRow[];
  chartType: ChartType;
  groupMode: TaskChartGroupMode;
  groupOverride: ChartGroupMode;
  onTaskGroupByChange: (taskKey: string, groupBy: ChartGroupMode) => void;
  labels: ExperimentLabels;
  onHoverRow: (rowId: string | null) => void;
  onToggleRow: (rowId: string) => void;
  hoveredRowId: string | null;
  selectedRowIds: ReadonlySet<string>;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  // Each experiment is evaluated on a single task, so most rows have no data
  // for any given task. Plotting all rows leaves the chart mostly empty (and
  // makes the radar unreadable), so keep only rows that were evaluated on this
  // task. Filter on null (not evaluated) — a real 0% result still shows.
  const taskRows = useMemo(
    () => rows.filter((row) => rowHasTaskData(row, task.taskKey, task.evalSets)),
    [rows, task.evalSets, task.taskKey],
  );
  const matrix = useMemo<TaskChartMatrix>(() => {
    const rowItems = taskRows.map((row, index) => ({
      key: `row_${index}`,
      label: labels.labelByRowId[row.id] ?? row.experiment,
      rowId: row.id,
    }));
    const evalSetItems = task.evalSets.map((evalSet) => ({
      key: evalSet,
      label: evalSet,
      rowId: "",
    }));
    const rowsById = new Map(taskRows.map((row) => [row.id, row]));
    const cellFor = (group: ChartAxisItem, series: ChartAxisItem) => {
      const rowId = group.rowId || series.rowId;
      const evalSet = group.rowId ? series.key : group.key;
      return rowsById.get(rowId)?.values[task.taskKey]?.[evalSet];
    };
    return {
      groupMode,
      groups: groupMode === "evalSet" ? evalSetItems : rowItems,
      seriesItems: groupMode === "evalSet" ? rowItems : evalSetItems,
      cellFor,
      rowIdFor: (group, series) => group.rowId || series.rowId,
    };
  }, [groupMode, labels.labelByRowId, task.evalSets, task.taskKey, taskRows]);
  const experimentById = useMemo(
    () => Object.fromEntries(taskRows.map((row) => [row.id, row.experiment])),
    [taskRows],
  );
  const displayByRowEval = useMemo(() => {
    const lookup: Record<string, Record<string, string>> = {};
    for (const row of taskRows) {
      const byEval: Record<string, string> = {};
      for (const evalSet of task.evalSets) {
        byEval[evalSet] = row.values[task.taskKey]?.[evalSet]?.display || "-";
      }
      lookup[row.id] = byEval;
    }
    return lookup;
  }, [taskRows, task.evalSets, task.taskKey]);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const measure = () => {
      const nextWidth = Math.ceil(scroller.getBoundingClientRect().width);
      setAvailableWidth((current) => (current === nextWidth ? current : nextWidth));
    };

    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(scroller);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <section className="taskChart">
      <div className="taskChartHeader">
        <div className="taskChartTitle">{task.label}</div>
        <SsotSelect
          className="compactSelect"
          aria-label={`Grouping for ${task.label}`}
          value={groupOverride}
          options={TASK_GROUP_SELECT_OPTIONS}
          onChange={(value) => onTaskGroupByChange(task.taskKey, value as ChartGroupMode)}
        />
      </div>
      <div ref={scrollerRef} className="taskChartScroller">
        <TaskChartRenderer
          task={task}
          matrix={matrix}
          chartType={chartType}
          availableWidth={availableWidth}
          labels={labels}
          experimentById={experimentById}
          displayByRowEval={displayByRowEval}
          onHoverRow={onHoverRow}
          onToggleRow={onToggleRow}
          hoveredRowId={hoveredRowId}
          selectedRowIds={selectedRowIds}
        />
      </div>
    </section>
  );
});

type RendererProps = {
  task: ChartTaskDescriptor;
  matrix: TaskChartMatrix;
  chartType: ChartType;
  availableWidth: number;
  labels: ExperimentLabels;
  experimentById: Record<string, string>;
  displayByRowEval: Record<string, Record<string, string>>;
  onHoverRow: (rowId: string | null) => void;
  onToggleRow: (rowId: string) => void;
  hoveredRowId: string | null;
  selectedRowIds: ReadonlySet<string>;
};

function TaskChartRenderer(props: RendererProps) {
  switch (props.chartType) {
    case "line":
      return <LineChart {...props} />;
    case "radar":
      return <RadarChart {...props} />;
    case "heatmap":
      return <HeatmapChart {...props} />;
    case "bar":
    default:
      return <BarChart {...props} />;
  }
}

function BarChart({
  matrix,
  availableWidth,
  experimentById,
  onHoverRow,
  onToggleRow,
  hoveredRowId,
  selectedRowIds,
}: RendererProps) {
  const data = useMemo(
    () => matrix.groups.map((group) => taskBarDatum(group, matrix, experimentById)),
    [experimentById, matrix],
  );
  const keys = useMemo(() => matrix.seriesItems.map((item) => item.key), [matrix.seriesItems]);

  // Experiment group labels are long; slant them like the line chart does.
  const rotateTicks = matrix.groupMode === "experiment";
  const contentWidth =
    AXIS_WIDTH + matrix.groups.length * matrix.seriesItems.length * BAR_WIDTH + 8;
  const chartWidth = Math.max(MIN_CHART_WIDTH, availableWidth, contentWidth);
  const chartHeight = rotateTicks ? CHART_HEIGHT + ROTATED_TICKS_HEIGHT : CHART_HEIGHT;

  const barComponent = useMemo(
    () => makeBarComponent(onHoverRow, onToggleRow, hoveredRowId, selectedRowIds),
    [hoveredRowId, onHoverRow, onToggleRow, selectedRowIds],
  );

  return (
    <Bar
      width={chartWidth}
      height={chartHeight}
      data={data as unknown as Record<string, string | number>[]}
      keys={keys}
      indexBy="group"
      groupMode="grouped"
      layout="vertical"
      margin={{
        top: 8,
        right: 8,
        bottom: rotateTicks ? ROTATED_TICKS_BOTTOM_MARGIN : 24,
        left: AXIS_WIDTH,
      }}
      padding={0.2}
      innerPadding={1}
      valueScale={{ type: "linear", min: 0, max: 100 }}
      indexScale={{ type: "band", round: false }}
      colors={(datum: BarComputedDatum<Record<string, string | number>>) =>
        (datum.data as unknown as TaskBarDatum).colors[String(datum.id)] ?? DEFAULT_CELL_COLOR
      }
      theme={CHART_THEME}
      enableGridX={false}
      enableGridY
      gridYValues={Y_TICKS}
      enableLabel={false}
      animate={false}
      isInteractive
      barComponent={barComponent}
      axisBottom={{ ...AXIS_BOTTOM_BASE, tickRotation: rotateTicks ? -30 : 0 }}
      axisLeft={PERCENT_AXIS_LEFT}
      legends={[]}
    />
  );
}

function makeBarComponent(
  onHoverRow: (rowId: string | null) => void,
  onToggleRow: (rowId: string) => void,
  hoveredRowId: string | null,
  selectedRowIds: ReadonlySet<string>,
) {
  return function ChartBarItem({ bar }: BarItemProps<Record<string, string | number>>) {
    const tooltipApi = useContext(ChartTooltipContext);
    const key = String(bar.data.id);
    const datum = bar.data.data as unknown as TaskBarDatum;
    const rowId = datum.rowIds?.[key] ?? "";
    const stat = datum.stats?.[key];
    const tooltip = stat ? <TooltipCard title={stat.experiment} value={stat.display} /> : null;

    return (
      <rect
        className={interactionClass("chartBarCell resultSyncBar", rowId, hoveredRowId, selectedRowIds)}
        data-result-row-id={rowId}
        x={bar.x}
        y={bar.y}
        width={bar.width}
        height={bar.height}
        fill={bar.color}
        onClick={() => onToggleRow(rowId)}
        onMouseEnter={() => {
          onHoverRow(rowId);
          if (tooltip) tooltipApi.show(tooltip);
        }}
        onMouseLeave={() => {
          onHoverRow(null);
          tooltipApi.hide();
        }}
      />
    );
  };
}

function LineChart({
  task,
  matrix,
  availableWidth,
  labels,
  experimentById,
  displayByRowEval,
  onHoverRow,
  onToggleRow,
  hoveredRowId,
  selectedRowIds,
}: RendererProps) {
  // Groups on the x-axis, one line per series item. Points carry the label of
  // their experiment side so dots and hover sync resolve rows in either mode.
  const data = useMemo(
    () =>
      matrix.seriesItems.map((item) => ({
        id: item.label,
        data: matrix.groups.map((group) => ({
          x: group.label,
          y: chartCellPercent(matrix.cellFor(group, item), null),
          rowLabel: item.rowId ? item.label : group.label,
        })),
      })),
    [matrix],
  );
  const rotateTicks = matrix.groupMode === "experiment" && matrix.groups.length > 4;
  // Rotated tick labels extend left-down from their tick; widen the left
  // gutter so the first group's label is not clipped at the SVG edge.
  const leftMargin = rotateTicks
    ? labelGutter(maxItemLabelLength(matrix.groups), { scale: 0.87, min: AXIS_WIDTH, max: 140 })
    : AXIS_WIDTH;
  const contentWidth = leftMargin + matrix.groups.length * 56 + 12;
  const chartWidth = Math.max(MIN_CHART_WIDTH, availableWidth, contentWidth);
  const chartHeight = rotateTicks ? CHART_HEIGHT + ROTATED_TICKS_HEIGHT : CHART_HEIGHT;
  const tooltipApi = useContext(ChartTooltipContext);

  const showPointTooltip = (datum: unknown) => {
    const rowId = linePointRowId(datum, labels);
    if (!rowId) return;
    const seriesIndex = matrix.seriesItems.findIndex((item) => item.rowId === rowId);
    tooltipApi.show(
      <ChartSeriesTooltip
        title={experimentById[rowId] ?? rowId}
        entries={task.evalSets.map((evalSet, index) => ({
          label: evalSet,
          color: seriesColor(matrix.groupMode === "experiment" ? index : Math.max(seriesIndex, 0)),
          value: displayByRowEval[rowId]?.[evalSet] ?? "-",
        }))}
      />,
    );
  };

  return (
    <Line
      width={chartWidth}
      height={chartHeight}
      data={data}
      margin={{
        top: 8,
        right: 12,
        bottom: rotateTicks ? ROTATED_TICKS_BOTTOM_MARGIN : 28,
        left: leftMargin,
      }}
      xScale={{ type: "point" }}
      yScale={{ type: "linear", min: 0, max: 100 }}
      colors={FALLBACK_SERIES_COLORS}
      theme={CHART_THEME}
      enableGridX={false}
      enableGridY
      gridYValues={Y_TICKS}
      axisBottom={{ ...AXIS_BOTTOM_BASE, tickRotation: rotateTicks ? -30 : 0 }}
      axisLeft={PERCENT_AXIS_LEFT}
      enablePoints
      pointSize={6}
      pointSymbol={({ size, color, borderWidth, borderColor, datum }) => (
        // Despite the declared Point type, nivo passes the raw datum here, so
        // the rowLabel field survives.
        <SyncDot
          rowId={rowIdFromLabel((datum as unknown as { rowLabel?: unknown }).rowLabel, labels)}
          size={size}
          color={color}
          borderColor={borderColor}
          borderWidth={borderWidth}
          hoveredRowId={hoveredRowId}
          selectedRowIds={selectedRowIds}
        />
      )}
      useMesh
      animate={false}
      legends={[]}
      onMouseEnter={(datum) => {
        onHoverRow(linePointRowId(datum, labels));
        showPointTooltip(datum);
      }}
      onMouseMove={(datum) => {
        onHoverRow(linePointRowId(datum, labels));
        showPointTooltip(datum);
      }}
      onMouseLeave={() => {
        onHoverRow(null);
        tooltipApi.hide();
      }}
      onClick={(datum) => {
        const rowId = linePointRowId(datum, labels);
        if (rowId) onToggleRow(rowId);
      }}
      tooltip={() => null}
    />
  );
}

// The hovered point's experiment row: the line's serie when lines are
// experiments, otherwise the x value (groups are experiments then).
function linePointRowId(datum: unknown, labels: ExperimentLabels): string | null {
  const point = datum as { serieId?: unknown; data?: { x?: unknown } };
  const fromSerie = rowIdFromLabel(point?.serieId, labels);
  if (fromSerie) return fromSerie;
  if (!point?.data) return null;
  return rowIdFromLabel(point.data.x, labels) || null;
}

function RadarChart({
  matrix,
  availableWidth,
  labels,
  experimentById,
  onHoverRow,
  onToggleRow,
  hoveredRowId,
  selectedRowIds,
}: RendererProps) {
  // Groups as spokes, one polygon per series item.
  const data = useMemo(
    () =>
      matrix.groups.map((group) => {
        const datum: Record<string, string | number> = { group: group.label };
        for (const item of matrix.seriesItems) {
          // Radar renders unevaluated spokes at 0 (a gap would break the polygon).
          datum[item.label] = chartCellPercent(matrix.cellFor(group, item), 0) as number;
        }
        return datum;
      }),
    [matrix],
  );
  const keys = useMemo(() => matrix.seriesItems.map((item) => item.label), [matrix.seriesItems]);
  const chartWidth = Math.max(MIN_CHART_WIDTH, availableWidth);
  // Spoke labels render outward from the circle; size the side gutters to the
  // longest label so names are not clipped at the panel edges.
  const sideMargin = labelGutter(maxItemLabelLength(matrix.groups), { pad: 24, min: 90, max: 170 });

  return (
    <Radar
      width={chartWidth}
      height={CHART_HEIGHT + 50}
      data={data}
      keys={keys}
      indexBy="group"
      maxValue={100}
      margin={{ top: 28, right: sideMargin, bottom: 28, left: sideMargin }}
      colors={FALLBACK_SERIES_COLORS}
      theme={CHART_THEME}
      gridLabelOffset={10}
      dotSize={6}
      dotSymbol={({ size, color, borderColor, borderWidth, datum }) => (
        // Tag each dot for reverse sync (chip/table-row hover highlights it),
        // same contract as the line chart's points. Dots sit above the slice
        // hit layer, so keep them non-interactive. Eval-set spokes resolve to
        // no row and stay untagged.
        <SyncDot
          rowId={rowIdFromLabel((datum as unknown as { index?: unknown }).index, labels)}
          size={size}
          color={color}
          borderColor={borderColor}
          borderWidth={borderWidth}
          nonInteractive
          hoveredRowId={hoveredRowId}
          selectedRowIds={selectedRowIds}
        />
      )}
      animate={false}
      legends={[]}
      onClick={(datum) => {
        const rowId = rowIdFromLabel((datum as { group?: unknown }).group, labels);
        if (rowId) onToggleRow(rowId);
      }}
      sliceTooltip={({ index }) => {
        const label = String(index);
        const rowId = rowIdFromLabel(index, labels);
        const group = matrix.groups.find((candidate) => candidate.label === label);
        return (
          <HoverSyncTooltip
            rowId={rowId}
            onHoverRow={onHoverRow}
            tooltip={
              <ChartSeriesTooltip
                title={rowId ? experimentById[rowId] ?? label : label}
                entries={matrix.seriesItems.map((item, itemIndex) => ({
                  label: item.label,
                  color: seriesColor(itemIndex),
                  value: group ? matrix.cellFor(group, item)?.display || "-" : "-",
                }))}
              />
            }
          />
        );
      }}
    />
  );
}

function HeatmapChart({
  matrix,
  availableWidth,
  labels,
  experimentById,
  displayByRowEval,
  onHoverRow,
  onToggleRow,
  hoveredRowId,
  selectedRowIds,
}: RendererProps) {
  const data = useMemo(
    () =>
      matrix.seriesItems.map((item) => ({
        id: item.key,
        data: matrix.groups.map((group) => ({
          x: group.label,
          y: chartCellPercent(matrix.cellFor(group, item), null),
        })),
      })),
    [matrix],
  );
  const seriesByKey = useMemo(
    () => new Map(matrix.seriesItems.map((item) => [item.key, item])),
    [matrix.seriesItems],
  );
  const rowIdForCell = useCallback(
    (serieId: unknown, x: unknown) =>
      seriesByKey.get(String(serieId))?.rowId || rowIdFromLabel(x, labels),
    [labels, seriesByKey],
  );
  const rotateTicks = matrix.groupMode === "experiment";
  const leftMargin = labelGutter(maxItemLabelLength(matrix.seriesItems), { pad: 20, max: 200 });
  const contentWidth = leftMargin + matrix.groups.length * HEATMAP_MIN_COL_WIDTH + 12;
  const chartWidth = Math.max(MIN_CHART_WIDTH, availableWidth, contentWidth);
  const chartHeight =
    (rotateTicks ? 48 + ROTATED_TICKS_HEIGHT : 48) +
    Math.max(1, matrix.seriesItems.length) * HEATMAP_ROW_HEIGHT;
  const tooltipApi = useContext(ChartTooltipContext);
  const cellComponent = useCallback(
    (props: CellComponentProps<HeatmapDatum>) => (
      <HeatmapCell
        {...props}
        rowId={rowIdForCell(props.cell.serieId, props.cell.data.x)}
        hoveredRowId={hoveredRowId}
        selectedRowIds={selectedRowIds}
      />
    ),
    [hoveredRowId, rowIdForCell, selectedRowIds],
  );

  const showCellTooltip = (cell: { serieId: string | number; data: { x: string | number } }) => {
    const rowId = rowIdForCell(cell.serieId, cell.data.x);
    const series = seriesByKey.get(String(cell.serieId));
    const evalSet = series?.rowId ? String(cell.data.x) : series?.key ?? String(cell.data.x);
    tooltipApi.show(
      <TooltipCard
        title={experimentById[rowId] ?? rowId}
        value={displayByRowEval[rowId]?.[evalSet] ?? "-"}
      />,
    );
  };

  return (
    <HeatMap
      width={chartWidth}
      height={chartHeight}
      data={data}
      margin={{
        top: 8,
        right: 12,
        bottom: rotateTicks ? ROTATED_TICKS_BOTTOM_MARGIN : 40,
        left: leftMargin,
      }}
      theme={CHART_THEME}
      colors={{ type: "sequential", scheme: "blues", minValue: 0, maxValue: 100 }}
      emptyColor={DEFAULT_CELL_COLOR}
      enableLabels
      label={(cell) => (cell.value == null ? "" : `${Math.round(cell.value)}`)}
      borderWidth={1}
      borderColor="var(--border-subtle)"
      cellComponent={cellComponent}
      animate={false}
      axisTop={null}
      axisBottom={{ ...AXIS_BOTTOM_BASE, tickRotation: rotateTicks ? -30 : 0 }}
      axisLeft={{
        ...AXIS_BOTTOM_BASE,
        format: (id) => seriesByKey.get(String(id))?.label ?? String(id),
      }}
      legends={[]}
      onMouseEnter={(cell) => {
        onHoverRow(rowIdForCell(cell.serieId, cell.data.x));
        showCellTooltip(cell);
      }}
      onMouseMove={(cell) => {
        onHoverRow(rowIdForCell(cell.serieId, cell.data.x));
        showCellTooltip(cell);
      }}
      onMouseLeave={() => {
        onHoverRow(null);
        tooltipApi.hide();
      }}
      onClick={(cell) => {
        const rowId = rowIdForCell(cell.serieId, cell.data.x);
        if (rowId) onToggleRow(rowId);
      }}
      tooltip={() => null}
    />
  );
}

type HeatmapDatum = { x: string; y: number | null };

// Custom cell so each rect carries the reverse-sync contract (resultSyncBar +
// data-result-row-id), letting chip/table-row hover highlight heatmap cells
// like it does bars and line points. Wires the handler factories nivo passes
// so forward hover, tooltip, and click-to-select keep working.
function HeatmapCell({
  cell,
  borderWidth,
  enableLabels,
  onMouseEnter,
  onMouseMove,
  onMouseLeave,
  onClick,
  rowId,
  hoveredRowId,
  selectedRowIds,
}: CellComponentProps<HeatmapDatum> & {
  rowId: string;
  hoveredRowId: string | null;
  selectedRowIds: ReadonlySet<string>;
}) {
  return (
    <g
      transform={`translate(${cell.x}, ${cell.y})`}
      style={{ cursor: "pointer" }}
      onMouseEnter={onMouseEnter?.(cell)}
      onMouseMove={onMouseMove?.(cell)}
      onMouseLeave={onMouseLeave?.(cell)}
      onClick={onClick?.(cell)}
    >
      <rect
        className={interactionClass("chartBarCell resultSyncBar", rowId, hoveredRowId, selectedRowIds)}
        data-result-row-id={rowId}
        x={-cell.width / 2}
        y={-cell.height / 2}
        width={cell.width}
        height={cell.height}
        fill={cell.color}
        stroke={cell.borderColor}
        strokeWidth={borderWidth}
      />
      {enableLabels && cell.label ? (
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fill={cell.labelTextColor}
          style={{ pointerEvents: "none" }}
        >
          {cell.label}
        </text>
      ) : null}
    </g>
  );
}

// Radar exposes no per-slice mouse events, only a tooltip render prop; a
// mounted tooltip IS the hover state. Sync the hovered row from its
// mount/unmount lifecycle and mirror the content into the floating tooltip
// portal (rendering it in place would be clipped by the chart scroller).
function HoverSyncTooltip({
  rowId,
  onHoverRow,
  tooltip,
}: {
  rowId: string;
  onHoverRow: (rowId: string | null) => void;
  tooltip: ReactNode;
}) {
  const tooltipApi = useContext(ChartTooltipContext);

  // Sync the hovered row only when the spoke changes. nivo re-renders this
  // component on every mousemove within a slice; keying on rowId alone avoids
  // the highlight flickering off/on as the pointer moves.
  useEffect(() => {
    if (!rowId) return undefined;
    onHoverRow(rowId);
    return () => onHoverRow(null);
  }, [onHoverRow, rowId]);

  // Update tooltip content each render; hide only when the slice is left
  // entirely (component unmount).
  useEffect(() => {
    tooltipApi.show(tooltip);
  }, [tooltip, tooltipApi]);
  useEffect(() => () => tooltipApi.hide(), [tooltipApi]);

  return null;
}

function TooltipCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="chartTooltip">
      <div className="chartTooltipTitle">{title}</div>
      <div className="chartTooltipValue">{value}</div>
    </div>
  );
}

function interactionClass(
  baseClass: string,
  rowId: string,
  hoveredRowId: string | null,
  selectedRowIds: ReadonlySet<string>,
) {
  const selected = selectedRowIds.has(rowId);
  return [
    baseClass,
    rowId === hoveredRowId || selected ? "resultSyncActive" : "",
    selected ? "resultSyncSelected" : "",
  ].filter(Boolean).join(" ");
}

// A chart dot tagged for reverse sync (chip/table-row hover highlights it).
// Shared by the line chart's points and the radar's dots; radar's sit above the
// slice hit layer so they opt into nonInteractive.
function SyncDot({
  rowId,
  size,
  color,
  borderColor,
  borderWidth,
  nonInteractive = false,
  hoveredRowId,
  selectedRowIds,
}: {
  rowId: string;
  size: number;
  color: string;
  borderColor: string;
  borderWidth: number;
  nonInteractive?: boolean;
  hoveredRowId: string | null;
  selectedRowIds: ReadonlySet<string>;
}) {
  return (
    <circle
      className={interactionClass("resultSyncBar", rowId, hoveredRowId, selectedRowIds)}
      data-result-row-id={rowId}
      r={size / 2}
      fill={color}
      stroke={borderColor}
      strokeWidth={borderWidth}
      style={nonInteractive ? { pointerEvents: "none" } : undefined}
    />
  );
}

// Shared multi-row tooltip: a title, then a colored dot + value per entry.
// Used by line and radar so their tooltips are identical.
function ChartSeriesTooltip({
  title,
  entries,
}: {
  title: string;
  entries: Array<{ label: string; color: string; value: string }>;
}) {
  return (
    <div className="chartTooltip">
      <div className="chartTooltipTitle">{title}</div>
      {entries.map((entry) => (
        <div key={entry.label} className="chartTooltipRow">
          <span
            className="chartTooltipDot"
            style={{ background: entry.color }}
            aria-hidden="true"
          />
          <span className="chartTooltipRowLabel">{entry.label}</span>
          <span className="chartTooltipRowValue">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

function taskBarDatum(
  group: ChartAxisItem,
  matrix: TaskChartMatrix,
  experimentById: Record<string, string>,
): TaskBarDatum {
  const datum: TaskBarDatum = {
    group: group.label,
    colors: {},
    stats: {},
    rowIds: {},
  };

  for (const item of matrix.seriesItems) {
    const cell = matrix.cellFor(group, item);
    const rowId = matrix.rowIdFor(group, item);
    datum[item.key] = chartCellPercent(cell, null);
    datum.colors[item.key] = cell?.color ?? DEFAULT_CELL_COLOR;
    datum.rowIds[item.key] = rowId;
    datum.stats[item.key] = {
      experiment: experimentById[rowId] ?? group.label,
      display: cell?.display || "-",
    };
  }

  return datum;
}

// Short, still-distinguishing labels: experiments usually share a long common
// prefix (e.g. dexjoco_physixel_pick_bucket_*) and only differ near the end.
function shortExperimentLabels(rows: ChartRow[]): ExperimentLabels {
  const prefixLength = commonTokenPrefixLength(rows.map((row) => row.experiment));
  const labelByRowId: Record<string, string> = {};
  const rowIdByLabel: Record<string, string> = {};

  for (const row of rows) {
    const tokens = row.experiment.split("_");
    const stripped = tokens.slice(Math.min(prefixLength, tokens.length - 1)).join("_");
    let label = truncateTail(stripped || row.experiment, 22);
    let suffix = 2;
    while (rowIdByLabel[label]) {
      label = `${truncateTail(stripped || row.experiment, 22)}~${suffix}`;
      suffix += 1;
    }
    labelByRowId[row.id] = label;
    rowIdByLabel[label] = row.id;
  }

  return { labelByRowId, rowIdByLabel };
}

function commonTokenPrefixLength(names: string[]): number {
  if (names.length < 2) return 0;
  const tokenLists = names.map((name) => name.split("_"));
  const firstTokens = tokenLists[0] ?? [];
  const minLength = Math.min(...tokenLists.map((tokens) => tokens.length));
  let length = 0;
  while (length < minLength && tokenLists.every((tokens) => tokens[length] === firstTokens[length])) {
    length += 1;
  }
  return length;
}

function truncateTail(value: string, max: number): string {
  return value.length > max ? `…${value.slice(-(max - 1))}` : value;
}

function rowHasTaskData(row: ChartRow, taskKey: string, evalSets: string[]): boolean {
  return evalSets.some((evalSet) => row.values[taskKey]?.[evalSet]?.value != null);
}

function maxItemLabelLength(items: ChartAxisItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.label.length), 0);
}
