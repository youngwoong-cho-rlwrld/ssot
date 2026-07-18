import { createSafeContext } from "@mantine/core";
import type { Dispatch, SetStateAction } from "react";
import type { Field } from "@enmight/types/apiTypes";
import type { Filters } from "@enmight/types/filterTypes";
import type { ColorStylerItemType, RowType, SortByItemType } from "@enmight/types/layoutTypes";

export type DataTableContextValue = {
  columns: Field[];
  visibleColumns: Field[];
  searchColumns: Field[];
  columnWidths: Record<string, number>;
  setVisibleColumnIds: (columnIds: string[] | null) => void;
  setSearchColumns: Dispatch<SetStateAction<Field[]>>;
  setColumnWidth: (columnId: string, width: number) => void;
  resetColumns: () => void;
  appliedFilters: Filters;
  setAppliedFilters: Dispatch<SetStateAction<Filters>>;
  sortByItems: SortByItemType[];
  setSortByItems: Dispatch<SetStateAction<SortByItemType[]>>;
  colorStylerItems: ColorStylerItemType[];
  setColorStylerItems: Dispatch<SetStateAction<ColorStylerItemType[]>>;
  resolveColor: (header: Field, row: RowType) => string | undefined;
};

export const [DataTableContextProvider, useDataTableContext] =
  createSafeContext<DataTableContextValue>(
    "useDataTableContext must be used within DataTable",
  );
