import {
  FILTER_OPERATORS,
  VALUELESS_FILTER_OPERATORS,
} from "../../lib/agentContract.mjs";

export { FILTER_OPERATORS, VALUELESS_FILTER_OPERATORS };

export type FilterOperator = (typeof FILTER_OPERATORS)[number];
export type FilterConjunction = "and" | "or";
export type FilterSource = "advanced-filter" | "agent" | "search";

export type ColumnFilter = {
  id: string;
  columnId: string;
  operator: FilterOperator | "";
  value: unknown;
  source?: FilterSource;
};

export type NestedFilter = {
  id: string;
  type: "nested";
  conjunction: FilterConjunction;
  filterSet: FilterNode[];
  source?: FilterSource;
};

export type FilterNode = ColumnFilter | NestedFilter;
type FilterSet = FilterNode[];

export type FilterGroup = {
  conjunction: FilterConjunction;
  filterSet: FilterSet;
};

export type Filters = {
  filters: FilterGroup;
  source?: FilterSource;
};
