import type { Filters } from "./filterTypes";

type CellValueType = string | number | boolean | null | undefined;

export type RowType = {
  id: string;
  __rowBold?: boolean;
  [key: string]: CellValueType;
};

// The editor uses nulls for an unfinished draft. Applied rules are validated
// before leaving the popover.
export type SortByItemType = {
  id: string;
  fieldId: string | null;
  sortState: "asc" | "desc" | null;
};

export type ColorStylerItemType = {
  id: string;
  color: string;
  targetType: "row" | "cell" | null;
  filter: Filters;
};
