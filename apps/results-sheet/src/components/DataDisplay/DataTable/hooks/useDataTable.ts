import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { Field } from "@enmight/types/apiTypes";

type UseDataTableProps = {
  headers: Field[];
  visibleColumnIds: string[];
  onVisibleColumnIdsChange: (columnIds: string[] | null) => void;
};

type DataTableColumns = {
  columns: Field[];
  visibleColumns: Field[];
  searchColumns: Field[];
  columnWidths: Record<string, number>;
  reorderColumn: (activeId: string, overId: string) => void;
  setVisibleColumnIds: (columnIds: string[] | null) => void;
  setSearchColumns: Dispatch<SetStateAction<Field[]>>;
  setColumnWidth: (columnId: string, width: number) => void;
  resetColumns: () => void;
};

export function useDataTableColumns({
  headers,
  visibleColumnIds,
  onVisibleColumnIdsChange,
}: UseDataTableProps): DataTableColumns {
  const [columnOrder, setColumnOrder] = useState(() => headers.map((header) => header.id));
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [searchColumnIds, setSearchColumnIds] = useState(() => textColumnIds(headers));

  useEffect(() => {
    const availableIds = new Set(headers.map((header) => header.id));
    setColumnOrder((current) => [
      ...current.filter((id) => availableIds.has(id)),
      ...headers.map((header) => header.id).filter((id) => !current.includes(id)),
    ]);
    setColumnWidths((current) => Object.fromEntries(
      Object.entries(current).filter(([id]) => availableIds.has(id)),
    ));
  }, [headers]);

  const headersById = useMemo(
    () => new Map(headers.map((header) => [header.id, header])),
    [headers],
  );
  const columns = useMemo(
    () => columnOrder.map((id) => headersById.get(id)).filter((field): field is Field => Boolean(field)),
    [columnOrder, headersById],
  );
  const visibleIdSet = useMemo(() => new Set(visibleColumnIds), [visibleColumnIds]);
  const visibleColumns = useMemo(
    () => columns.filter((column) => visibleIdSet.has(column.id)),
    [columns, visibleIdSet],
  );

  useEffect(() => {
    const visibleTextIds = textColumnIds(visibleColumns);
    setSearchColumnIds((current) => [
      ...current.filter((id) => visibleTextIds.includes(id)),
      ...visibleTextIds.filter((id) => !current.includes(id)),
    ]);
  }, [visibleColumns]);

  const searchColumns = useMemo(
    () => searchColumnIds
      .map((id) => headersById.get(id))
      .filter((field): field is Field => field !== undefined)
      .filter((field) => visibleIdSet.has(field.id)),
    [headersById, searchColumnIds, visibleIdSet],
  );

  const reorderColumn = useCallback((activeId: string, overId: string) => {
    setColumnOrder((current) => {
      const from = current.indexOf(activeId);
      const to = current.indexOf(overId);
      if (from < 0 || to < 0 || from === to) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      if (!moved) return current;
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const setVisibleColumnIds = useCallback((ids: string[] | null) => {
    if (ids === null) {
      onVisibleColumnIdsChange(null);
      return;
    }

    const requested = new Set(ids);
    const next = columns
      .filter((column) => requested.has(column.id))
      .map((column) => column.id);
    onVisibleColumnIdsChange(next.length > 0 && next.length < columns.length ? next : null);
  }, [columns, onVisibleColumnIdsChange]);

  const setSearchColumns: Dispatch<SetStateAction<Field[]>> = useCallback((nextValue) => {
    setSearchColumnIds((currentIds) => {
      const currentFields = currentIds
        .map((id) => headersById.get(id))
        .filter((field): field is Field => Boolean(field));
      const nextFields = typeof nextValue === "function" ? nextValue(currentFields) : nextValue;
      return nextFields.map((field) => field.id);
    });
  }, [headersById]);

  const setColumnWidth = useCallback((columnId: string, width: number) => {
    setColumnWidths((current) => ({ ...current, [columnId]: Math.max(50, Math.round(width)) }));
  }, []);

  const resetColumns = useCallback(() => {
    setColumnOrder(headers.map((header) => header.id));
    setColumnWidths({});
    setSearchColumnIds(textColumnIds(headers));
    onVisibleColumnIdsChange(null);
  }, [headers, onVisibleColumnIdsChange]);

  return {
    columns,
    visibleColumns,
    searchColumns,
    columnWidths,
    reorderColumn,
    setVisibleColumnIds,
    setSearchColumns,
    setColumnWidth,
    resetColumns,
  };
}

function textColumnIds(fields: Field[]) {
  return fields.filter((field) => field.type === "TEXT").map((field) => field.id);
}
