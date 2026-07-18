import type { ReactNode } from "react";
import type { Field } from "@enmight/types/apiTypes";
import type { Filters } from "@enmight/types/filterTypes";
import type { ColorStylerItemType, RowType, SortByItemType } from "@enmight/types/layoutTypes";

export type DataTableProps = {
  headers: Field[];
  rows: RowType[];
  height?: number | string;
  rowHeight?: number;
  defaultWidth?: number;
  appliedFilters: Filters;
  sortByItems: SortByItemType[];
  colorStylerItems: ColorStylerItemType[];
  visibleColumnIds: string[];
  onApplyFilters: (filters: Filters) => void;
  onApplySortBy: (items: SortByItemType[]) => void;
  onApplyColorStyler: (items: ColorStylerItemType[]) => void;
  onVisibleColumnIdsChange: (columnIds: string[] | null) => void;
  onHoverRow?: (row: RowType | null) => void;
  onToggleRow?: (row: RowType) => void;
  hoveredRowId: string | null;
  selectedRowIds: ReadonlySet<string>;
  actionGroups?: ReactNode[];
  loading?: boolean;
  emptyState?: ReactNode;
};

export type DataTableCellProps = {
  header: Field;
  row: RowType;
  rowHeight: number;
};

export type DataTableHeaderCellProps = {
  header: Field;
  width: number;
  resizingColumnId: string | null;
  onResizeStart: (header: Field, pageX: number, width: number) => void;
};
