"use client";

import { IconChartBar, IconMessageCircle, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildSheetModel } from "@/lib/results";
import { DataTable } from "@/components/DataDisplay/DataTable/DataTable";
import { ResultsChartPanel } from "@/components/ResultsChartPanel";
import {
  buildAgentRowsContext,
  buildChartRows as createChartRows,
  buildChartTasks as createChartTasks,
  buildTableHeaders,
  buildTableRows,
  sortSheetRows,
} from "@/lib/sheetView";
import {
  ResultsAgentPanel,
} from "@/components/ResultsAgentPanel";
import toolbarClasses from "@/components/ResultsToolbarActions.module.css";
import { useResultRowSync } from "@/hooks/useResultRowSync";
import { useResultsData } from "@/hooks/useResultsData";
import { useResultsViewState } from "@/hooks/useResultsViewState";
import { useResultsAgent } from "@/hooks/useResultsAgent";
import { usePanelResize } from "@/hooks/usePanelResize";
import {
  agentColumnContext,
  type AgentAction,
} from "@/lib/agentActions";
import type { ChartGroupMode } from "@/lib/chartTypes";
import { Button } from "@enmight/baseComponents/Buttons/Button";
import type { RowType } from "@enmight/types/layoutTypes";
import { rowMatchesFilters } from "@enmight/utils/tables/filters";

const AGENT_PANEL_DEFAULT_WIDTH = 360;
const AGENT_PANEL_MIN_WIDTH = 300;
const AGENT_PANEL_MAX_WIDTH = 560;
const CHART_PANEL_DEFAULT_WIDTH = 720;
const CHART_PANEL_MIN_WIDTH = 480;
const CHART_PANEL_MAX_WIDTH = 1080;
const TABLE_MIN_WIDTH_DURING_RESIZE = 520;
const WORKSPACE_GAP_TOTAL = 16;

export default function Page() {
  const {
    mounted,
    view: {
      sort: sortByItems,
      filters: appliedFilters,
      colors: colorStylerItems,
      visibleColumnIds,
      chartOpen: chartPanelOpen,
      chartType,
      chartGroupBy,
      chartGroupOverrides,
      chatOpen: agentPanelOpen,
    },
    setSort: setSortByItems,
    setFilters: setAppliedFilters,
    setColors: setColorStylerItems,
    setVisibleColumnIds,
    setChartOpen: setChartPanelOpen,
    setChartType,
    setChartGroupBy,
    setChartGroupOverrides,
    setChatOpen: setAgentPanelOpen,
    reconcileColumns,
    applyAgentActions,
  } = useResultsViewState();
  const [chartPanelWidth, setChartPanelWidth] = useState(CHART_PANEL_DEFAULT_WIDTH);
  const [agentPanelWidth, setAgentPanelWidth] = useState(AGENT_PANEL_DEFAULT_WIDTH);
  const {
    workspaceRef: resizeWorkspaceRef,
    resizingPanel,
    startResize: startPanelResize,
    resizeBy: resizePanelBy,
  } = usePanelResize({
    agent: {
      open: agentPanelOpen,
      width: agentPanelWidth,
      minWidth: AGENT_PANEL_MIN_WIDTH,
      maxWidth: AGENT_PANEL_MAX_WIDTH,
      setWidth: setAgentPanelWidth,
    },
    chart: {
      open: chartPanelOpen,
      width: chartPanelWidth,
      minWidth: CHART_PANEL_MIN_WIDTH,
      maxWidth: CHART_PANEL_MAX_WIDTH,
      setWidth: setChartPanelWidth,
    },
    tableMinWidth: TABLE_MIN_WIDTH_DURING_RESIZE,
    workspaceGap: WORKSPACE_GAP_TOTAL,
  });

  const { response, isFetching, anyResultLoaded, initialLoading, loadError, refresh } = useResultsData();

  const model = useMemo(() => buildSheetModel(response), [response]);
  const sortedRows = useMemo(() => sortSheetRows(model.rows, sortByItems), [model.rows, sortByItems]);
  const headers = useMemo(() => buildTableHeaders(model.performanceColumns), [model.performanceColumns]);
  const allColumnIds = useMemo(() => headers.map((header) => header.id), [headers]);
  const effectiveVisibleColumnIds = visibleColumnIds ?? allColumnIds;
  const tableRows = useMemo(
    () => buildTableRows(sortedRows, model.performanceColumns),
    [sortedRows, model.performanceColumns],
  );
  const filteredTableRows = useMemo(
    () => tableRows.filter((row) => rowMatchesFilters(row, appliedFilters)),
    [appliedFilters, tableRows],
  );
  const filteredRowIds = useMemo(
    () => new Set(filteredTableRows.map((row) => row.id)),
    [filteredTableRows],
  );
  const chartRows = useMemo(
    () => sortedRows.filter((row) => filteredRowIds.has(row.id)),
    [filteredRowIds, sortedRows],
  );
  const chartTasks = useMemo(
    () => createChartTasks(model.performanceColumns, chartRows),
    [chartRows, model.performanceColumns],
  );
  const chartDataRows = useMemo(
    () => createChartRows(chartRows, tableRows, headers, model.performanceColumns, colorStylerItems),
    [chartRows, colorStylerItems, headers, model.performanceColumns, tableRows],
  );
  const chartRowIds = useMemo(() => chartDataRows.map((row) => row.id), [chartDataRows]);
  const {
    hoveredRowId,
    selectedRowIds,
    handleRowHover: handleResultRowHover,
    handleRowToggle: handleResultRowToggle,
  } = useResultRowSync(chartRowIds);
  const handleTableRowHover = useCallback(
    (row: RowType | null) => handleResultRowHover(row ? String(row.id) : null),
    [handleResultRowHover],
  );
  const handleTableRowToggle = useCallback(
    (row: RowType) => handleResultRowToggle(String(row.id)),
    [handleResultRowToggle],
  );
  const agentContext = useMemo(() => {
    const currentRows = chartRows.slice(0, 120);
    const allRows = sortedRows.slice(0, 120);
    return {
      columns: agentColumnContext(headers),
      visibleColumnIds: effectiveVisibleColumnIds,
      sortByItems,
      appliedFilters,
      colorStylerItems,
      chartPanelOpen,
      chartType,
      chartGroupBy,
      chartGroupOverrides,
      rowCount: tableRows.length,
      filteredRowCount: chartRows.length,
      ...buildAgentRowsContext(currentRows, allRows, model.performanceColumns),
      allFilteredRowsIncluded: chartRows.length <= 120,
      allRowsIncluded: sortedRows.length <= 120,
    };
  }, [
    appliedFilters,
    chartGroupBy,
    chartGroupOverrides,
    chartPanelOpen,
    chartRows,
    chartType,
    colorStylerItems,
    effectiveVisibleColumnIds,
    headers,
    model.performanceColumns,
    sortByItems,
    sortedRows,
    tableRows.length,
  ]);
  const handleAgentActions = useCallback((actions: AgentAction[]) => {
    applyAgentActions(actions, allColumnIds, refresh);
  }, [allColumnIds, applyAgentActions, refresh]);
  const {
    status: agentStatus,
    statusDetail: agentStatusDetail,
    models: agentModels,
    selectedModel: agentSelectedModel,
    setSelectedModel: setAgentSelectedModel,
    messages: agentMessages,
    pending: agentPending,
    send: handleAgentSend,
  } = useResultsAgent({
    enabled: agentPanelOpen,
    context: agentContext,
    columns: headers,
    applyActions: handleAgentActions,
  });
  const handleTaskGroupByChange = useCallback((taskKey: string, groupBy: ChartGroupMode) => {
    setChartGroupOverrides((current) => {
      if (groupBy === "auto") {
        if (!(taskKey in current)) return current;
        const { [taskKey]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [taskKey]: groupBy };
    });
  }, [setChartGroupOverrides]);
  const toggleAgentPanel = useCallback(() => {
    setAgentPanelOpen((open) => !open);
  }, [setAgentPanelOpen]);
  const toggleChartPanel = useCallback(() => {
    setChartPanelOpen((open) => !open);
  }, [setChartPanelOpen]);
  const tableActions = useMemo(
    () => [
      <ChatActionButton
        key="chat"
        active={agentPanelOpen}
        onClick={toggleAgentPanel}
      />,
      <ChartActionButton
        key="chart"
        active={chartPanelOpen}
        onClick={toggleChartPanel}
      />,
      <Button
        key="refresh"
        size="compact-sm"
        className={toolbarClasses.toolbarButton}
        leftSection={
              isFetching
                ? <span className="agentLoadingSpinner" aria-hidden="true" />
                : <IconRefresh size={14} stroke={1.3} aria-hidden="true" />
        }
        onClick={refresh}
        disabled={isFetching}
      >
        Refresh
      </Button>,
    ],
    [agentPanelOpen, chartPanelOpen, isFetching, refresh, toggleAgentPanel, toggleChartPanel],
  );

  useEffect(() => {
    if (mounted) reconcileColumns(headers);
  }, [headers, mounted, reconcileColumns]);

  return (
    <main className="ssot-page page">
      {loadError && (
        <div className="status statusError">
          {loadError}
        </div>
      )}
      {model.errors.map((item) => (
        <div key={`${item.cluster}-${item.error}`} className="status statusError">
          {item.cluster}: {item.error}
        </div>
      ))}

      {mounted && (
        <div
          ref={resizeWorkspaceRef}
          className={[
            "resultsWorkspace",
            chartPanelOpen || agentPanelOpen ? "resultsWorkspacePanelOpen" : "",
            resizingPanel === "agent" ? "resultsWorkspaceResizingAgent" : "",
            resizingPanel === "chart" ? "resultsWorkspaceResizingChart" : "",
          ].filter(Boolean).join(" ")}
        >
          <ResultsAgentPanel
            open={agentPanelOpen}
            width={agentPanelWidth}
            minWidth={AGENT_PANEL_MIN_WIDTH}
            maxWidth={AGENT_PANEL_MAX_WIDTH}
            status={agentStatus}
            statusDetail={agentStatusDetail}
            models={agentModels}
            selectedModel={agentSelectedModel}
            messages={agentMessages}
            pending={agentPending}
            onResizeStart={(event) => startPanelResize("agent", event)}
            onResizeBy={(delta) => resizePanelBy("agent", delta)}
            onClose={() => setAgentPanelOpen(false)}
            onModelChange={setAgentSelectedModel}
            onSend={handleAgentSend}
          />
          <div className="tableShell">
            <DataTable
              headers={headers}
              rows={filteredTableRows}
              height="100%"
              rowHeight={42}
              defaultWidth={170}
              sortByItems={sortByItems}
              colorStylerItems={colorStylerItems}
              appliedFilters={appliedFilters}
              visibleColumnIds={effectiveVisibleColumnIds}
              onApplyFilters={setAppliedFilters}
              onApplySortBy={setSortByItems}
              onApplyColorStyler={setColorStylerItems}
              onVisibleColumnIdsChange={setVisibleColumnIds}
              onHoverRow={handleTableRowHover}
              onToggleRow={handleTableRowToggle}
              hoveredRowId={hoveredRowId}
              selectedRowIds={selectedRowIds}
              actionGroups={tableActions}
              loading={initialLoading}
              emptyState={<span>{anyResultLoaded ? "No matching results" : "No results loaded"}</span>}
            />
          </div>
          {chartPanelOpen && (
            <ResultsChartPanel
              width={chartPanelWidth}
              minWidth={CHART_PANEL_MIN_WIDTH}
              maxWidth={CHART_PANEL_MAX_WIDTH}
              tasks={chartTasks}
              rows={chartDataRows}
              chartType={chartType}
              groupBy={chartGroupBy}
              groupOverrides={chartGroupOverrides}
              onChartTypeChange={setChartType}
              onGroupByChange={setChartGroupBy}
              onTaskGroupByChange={handleTaskGroupByChange}
              onResizeStart={(event) => startPanelResize("chart", event)}
              onResizeBy={(delta) => resizePanelBy("chart", delta)}
              onHoverRow={handleResultRowHover}
              onToggleRow={handleResultRowToggle}
              hoveredRowId={hoveredRowId}
              selectedRowIds={selectedRowIds}
              onClose={() => setChartPanelOpen(false)}
            />
          )}
        </div>
      )}
    </main>
  );
}

function ChatActionButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="compact-sm"
      className={active ? toolbarClasses.toolbarButtonActive : toolbarClasses.toolbarButton}
      aria-pressed={active}
      leftSection={<IconMessageCircle size={14} stroke={1.3} aria-hidden="true" />}
      onClick={onClick}
    >
      Chat
    </Button>
  );
}

function ChartActionButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="compact-sm"
      className={active ? toolbarClasses.toolbarButtonActive : toolbarClasses.toolbarButton}
      aria-pressed={active}
      leftSection={<IconChartBar size={14} stroke={1.3} aria-hidden="true" />}
      onClick={onClick}
    >
      Chart
    </Button>
  );
}
