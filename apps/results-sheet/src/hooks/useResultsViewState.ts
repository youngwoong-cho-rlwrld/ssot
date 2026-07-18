import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  AGENT_ACTIONS,
  createColorRulesFromAgentRules,
  createFiltersFromConditions,
  createSortByItems,
  emptyAgentFilters,
  type AgentAction,
} from "@/lib/agentActions";
import {
  DEFAULT_CHART_GROUP_MODE,
  DEFAULT_CHART_TYPE,
  type ChartGroupMode,
  type ChartGroupOverrides,
  type ChartType,
} from "@/lib/chartTypes";
import {
  decodeViewState,
  encodeViewState,
  reconcileViewStateColumns,
  type ViewState,
} from "@/lib/viewState";
import type { Filters } from "@enmight/types/filterTypes";
import type { Field } from "@enmight/types/apiTypes";
import type { ColorStylerItemType, SortByItemType } from "@enmight/types/layoutTypes";

export function useResultsViewState() {
  const [mounted, setMounted] = useState(false);
  const [view, setView] = useState<ViewState>(() => ({
    sort: [],
    filters: emptyAgentFilters(),
    colors: [],
    visibleColumnIds: null,
    chartOpen: false,
    chartType: DEFAULT_CHART_TYPE,
    chartGroupBy: DEFAULT_CHART_GROUP_MODE,
    chartGroupOverrides: {},
    chatOpen: false,
  }));

  const setSort = useViewFieldSetter(setView, "sort");
  const setFilters = useViewFieldSetter(setView, "filters");
  const setColors = useViewFieldSetter(setView, "colors");
  const setVisibleColumnIds = useViewFieldSetter(setView, "visibleColumnIds");
  const setChartOpen = useViewFieldSetter(setView, "chartOpen");
  const setChartType = useViewFieldSetter(setView, "chartType");
  const setChartGroupBy = useViewFieldSetter(setView, "chartGroupBy");
  const setChartGroupOverrides = useViewFieldSetter(setView, "chartGroupOverrides");
  const setChatOpen = useViewFieldSetter(setView, "chatOpen");

  useEffect(() => {
    setView((current) => ({ ...current, ...decodeViewState(window.location.search) }));
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const query = encodeViewState(view);
    const url = query ? `${window.location.pathname}?${query}` : window.location.pathname;
    window.history.replaceState(window.history.state, "", url);
  }, [mounted, view]);

  const reconcileColumns = useCallback((columns: Field[]) => {
    setView((current) => reconcileViewStateColumns(current, columns));
  }, []);

  const applyAgentActions = useCallback((
    actions: AgentAction[],
    allColumnIds: string[],
    refresh: () => void,
  ) => {
    for (const action of actions) {
      switch (action.type) {
        case AGENT_ACTIONS.SET_SORT:
          setSort(createSortByItems(action.items));
          break;
        case AGENT_ACTIONS.CLEAR_SORT:
          setSort([]);
          break;
        case AGENT_ACTIONS.SET_FILTERS:
          setFilters(createFiltersFromConditions(action.conditions, action.conjunction));
          break;
        case AGENT_ACTIONS.CLEAR_FILTERS:
          setFilters(emptyAgentFilters());
          break;
        case AGENT_ACTIONS.SHOW_COLUMNS:
          setVisibleColumnIds((current) => {
            if (current === null) return null;
            const visible = new Set(current ?? allColumnIds);
            action.columnIds.forEach((columnId) => visible.add(columnId));
            return canonicalVisibleColumns(
              allColumnIds.filter((columnId) => visible.has(columnId)),
              allColumnIds,
            );
          });
          break;
        case AGENT_ACTIONS.HIDE_COLUMNS:
          setVisibleColumnIds((current) => {
            const visible = new Set(current ?? allColumnIds);
            action.columnIds.forEach((columnId) => visible.delete(columnId));
            const next = allColumnIds.filter((columnId) => visible.has(columnId));
            return next.length ? canonicalVisibleColumns(next, allColumnIds) : current;
          });
          break;
        case AGENT_ACTIONS.SET_VISIBLE_COLUMNS: {
          const next = allColumnIds.filter((columnId) => action.columnIds.includes(columnId));
          if (next.length) setVisibleColumnIds(canonicalVisibleColumns(next, allColumnIds));
          break;
        }
        case AGENT_ACTIONS.SET_COLOR_RULES:
          setColors(createColorRulesFromAgentRules(action.rules));
          break;
        case AGENT_ACTIONS.CLEAR_COLORS:
          setColors([]);
          break;
        case AGENT_ACTIONS.REFRESH:
          refresh();
          break;
        case AGENT_ACTIONS.SET_CHART_OPEN:
          setChartOpen(action.open);
          break;
        case AGENT_ACTIONS.SET_CHART_TYPE:
          setChartType(action.chartType);
          setChartOpen(true);
          break;
        case AGENT_ACTIONS.SET_CHART_GROUPING:
          setChartGroupBy(action.groupBy);
          setChartGroupOverrides(Object.fromEntries(
            action.taskOverrides.map((override) => [override.taskKey, override.groupBy]),
          ));
          setChartOpen(true);
          break;
      }
    }
  }, [setChartGroupBy, setChartGroupOverrides, setChartOpen, setChartType, setColors, setFilters, setSort, setVisibleColumnIds]);

  return {
    mounted,
    view,
    setSort,
    setFilters,
    setColors,
    setVisibleColumnIds,
    setChartOpen,
    setChartType,
    setChartGroupBy,
    setChartGroupOverrides,
    setChatOpen,
    reconcileColumns,
    applyAgentActions,
  };
}

function canonicalVisibleColumns(columnIds: string[], allColumnIds: string[]): string[] | null {
  return columnIds.length === allColumnIds.length ? null : columnIds;
}

type ViewFieldValue = {
  sort: SortByItemType[];
  filters: Filters;
  colors: ColorStylerItemType[];
  visibleColumnIds: string[] | null;
  chartOpen: boolean;
  chartType: ChartType;
  chartGroupBy: ChartGroupMode;
  chartGroupOverrides: ChartGroupOverrides;
  chatOpen: boolean;
};

function useViewFieldSetter<K extends keyof ViewFieldValue>(
  setView: Dispatch<SetStateAction<ViewState>>,
  field: K,
): Dispatch<SetStateAction<ViewFieldValue[K]>> {
  return useCallback((nextValue) => {
    setView((current) => ({
      ...current,
      [field]: typeof nextValue === "function"
        ? (nextValue as (value: ViewFieldValue[K]) => ViewFieldValue[K])(current[field])
        : nextValue,
    }));
  }, [field, setView]);
}
