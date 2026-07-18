import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { Flex, Skeleton, Stack } from "@mantine/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type UIEvent,
} from "react";
import { DataTableContextProvider, type DataTableContextValue } from "./context/DataTable.context";
import { useDataTableColumns } from "./hooks/useDataTable";
import DataTableActionBar from "./components/DataTableActionBar";
import DataTableCell from "./components/DataTableCell";
import DataTableHeaderCell from "./components/DataTableDraggableHeaderCell";
import DataTableSearchBar from "./components/DataTableSearchBar";
import type { DataTableProps } from "./types";
import type { Field } from "@enmight/types/apiTypes";
import { createTableColorResolver } from "@/lib/tableColors";
import styles from "./DataTable.module.css";

const SKELETON_CELL_WIDTHS = [72, 56, 64, 48, 78, 62, 54, 68] as const;

type ResizeState = {
  columnId: string;
  startX: number;
  startWidth: number;
};

export function DataTable({
  headers,
  rows,
  height = "100%",
  rowHeight = 42,
  defaultWidth = 170,
  appliedFilters,
  sortByItems,
  colorStylerItems,
  visibleColumnIds,
  onApplyFilters,
  onApplySortBy,
  onApplyColorStyler,
  onVisibleColumnIdsChange,
  onHoverRow,
  onToggleRow,
  hoveredRowId,
  selectedRowIds,
  actionGroups,
  loading = false,
  emptyState,
}: DataTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [showTopShadow, setShowTopShadow] = useState(false);
  const [showBottomShadow, setShowBottomShadow] = useState(false);

  const columnState = useDataTableColumns({
    headers,
    visibleColumnIds,
    onVisibleColumnIdsChange,
  });
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => rowHeight,
    overscan: 6,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows[0]?.start ?? 0;
  const lastVirtualRow = virtualRows.at(-1);
  const paddingBottom = lastVirtualRow
    ? rowVirtualizer.getTotalSize() - lastVirtualRow.end
    : 0;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const setAppliedFilters = useControlledSetter(appliedFilters, onApplyFilters);
  const setSortByItems = useControlledSetter(sortByItems, onApplySortBy);
  const setColorStylerItems = useControlledSetter(colorStylerItems, onApplyColorStyler);
  const resolveColor = useMemo(
    () => createTableColorResolver(colorStylerItems),
    [colorStylerItems],
  );

  const contextValue = useMemo<DataTableContextValue>(() => ({
    columns: columnState.columns,
    visibleColumns: columnState.visibleColumns,
    searchColumns: columnState.searchColumns,
    columnWidths: columnState.columnWidths,
    setVisibleColumnIds: columnState.setVisibleColumnIds,
    setSearchColumns: columnState.setSearchColumns,
    setColumnWidth: columnState.setColumnWidth,
    resetColumns: columnState.resetColumns,
    appliedFilters,
    setAppliedFilters,
    sortByItems,
    setSortByItems,
    colorStylerItems,
    setColorStylerItems,
    resolveColor,
  }), [
    appliedFilters,
    colorStylerItems,
    columnState,
    setAppliedFilters,
    setColorStylerItems,
    resolveColor,
    setSortByItems,
    sortByItems,
  ]);

  const columnWidth = useCallback(
    (header: Field) => columnState.columnWidths[header.id] ?? defaultWidth,
    [columnState.columnWidths, defaultWidth],
  );
  const totalWidth = useMemo(
    () => columnState.visibleColumns.reduce((sum, header) => sum + columnWidth(header), 0),
    [columnState.visibleColumns, columnWidth],
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    columnState.reorderColumn(String(event.active.id), String(event.over.id));
  }, [columnState]);

  const handleResizeStart = useCallback((header: Field, startX: number, startWidth: number) => {
    setResizeState({ columnId: header.id, startX, startWidth });
  }, []);

  useEffect(() => {
    if (!resizeState) return;
    const handleMove = (event: MouseEvent) => {
      columnState.setColumnWidth(
        resizeState.columnId,
        resizeState.startWidth + event.pageX - resizeState.startX,
      );
    };
    const handleUp = () => setResizeState(null);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp, { once: true });
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [columnState, resizeState]);

  const updateScrollShadows = useCallback((element: HTMLDivElement) => {
    setShowTopShadow(element.scrollTop > 0);
    setShowBottomShadow(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
  }, []);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    updateScrollShadows(event.currentTarget);
  }, [updateScrollShadows]);

  useEffect(() => {
    const element = containerRef.current;
    if (element) updateScrollShadows(element);
  }, [loading, rows.length, updateScrollShadows, virtualRows.length]);

  return (
    <DataTableContextProvider value={contextValue}>
      <Stack gap={0} w="100%" h="100%" style={{ minHeight: 0, overflow: "hidden" }}>
        <DataTableActionBar actionGroups={actionGroups} />
        <Flex pos="relative" h={40}>
          <DataTableSearchBar />
        </Flex>
        <div className={styles.tableViewportShell}>
          <div
            className={styles.bottomShadow}
            data-visible={showBottomShadow || undefined}
            aria-hidden="true"
          />
          <div
            ref={containerRef}
            className={styles.outerContainer}
            style={{ height, maxHeight: height }}
            onScroll={handleScroll}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
            >
              <SortableContext
                items={columnState.visibleColumns.map((column) => column.id)}
                strategy={horizontalListSortingStrategy}
              >
                <table className={styles.table} style={{ minWidth: Math.max(totalWidth, 1) }}>
                  <colgroup>
                    {columnState.visibleColumns.map((header) => (
                      <col key={header.id} style={{ width: columnWidth(header) }} />
                    ))}
                  </colgroup>
                  <thead
                    className={styles.thead}
                    style={{
                      boxShadow: showTopShadow ? "0 5px 8px rgba(0, 0, 0, 0.1)" : undefined,
                      transition: "box-shadow 0.4s",
                    }}
                  >
                    <tr className={styles.tr}>
                      {columnState.visibleColumns.map((header) => (
                        <DataTableHeaderCell
                          key={header.id}
                          header={header}
                          width={columnWidth(header)}
                          resizingColumnId={resizeState?.columnId ?? null}
                          onResizeStart={handleResizeStart}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody className={styles.tbody}>
                    {!loading && paddingTop > 0 && (
                      <SpacerRow height={paddingTop} columns={columnState.visibleColumns.length} />
                    )}
                    {loading ? (
                      Array.from({ length: 20 }, (_, rowIndex) => (
                        <tr key={`skeleton-${rowIndex}`}>
                          {columnState.visibleColumns.map((header, columnIndex) => (
                            <td key={header.id} style={{ width: "auto", height: rowHeight }}>
                              <Skeleton
                                height={18}
                                width={`${SKELETON_CELL_WIDTHS[(rowIndex + columnIndex) % SKELETON_CELL_WIDTHS.length]}%`}
                                radius="sm"
                                style={{ opacity: 0.5 }}
                              />
                            </td>
                          ))}
                        </tr>
                      ))
                    ) : virtualRows.length ? (
                      virtualRows.map((virtualRow) => {
                        const row = rows[virtualRow.index];
                        if (!row) return null;
                        const selected = selectedRowIds.has(row.id);
                        return (
                          <tr
                            key={row.id}
                            data-index={virtualRow.index}
                            data-result-row-id={row.id}
                            className={[
                              styles.tr,
                              "resultSyncTableRow",
                              row.__rowBold ? styles.boldRow : "",
                              row.id === hoveredRowId || selected ? "resultSyncActive" : "",
                              selected ? "resultSyncSelected" : "",
                            ].filter(Boolean).join(" ")}
                            onClick={() => onToggleRow?.(row)}
                            onMouseEnter={() => onHoverRow?.(row)}
                            onMouseLeave={() => onHoverRow?.(null)}
                            style={{ cursor: onToggleRow ? "pointer" : "default" }}
                          >
                            {columnState.visibleColumns.map((header) => (
                              <DataTableCell key={header.id} header={header} row={row} rowHeight={rowHeight} />
                            ))}
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td
                          colSpan={Math.max(1, columnState.visibleColumns.length)}
                          style={{
                            padding: 0,
                            lineHeight: 0,
                            verticalAlign: "middle",
                            boxShadow: "inset 0 1px 0 var(--border-subtle-2), 0 1px 0 var(--border-subtle-2), inset -1px 0 0 var(--border-subtle-2), inset 1px 0 0 var(--border-subtle-2)",
                          }}
                        >
                          <Stack gap={8} w="100%" justify="center" align="center" py={20}>
                            {emptyState ?? "No results"}
                          </Stack>
                        </td>
                      </tr>
                    )}
                    {!loading && paddingBottom > 0 && (
                      <SpacerRow height={paddingBottom} columns={columnState.visibleColumns.length} />
                    )}
                  </tbody>
                </table>
              </SortableContext>
            </DndContext>
          </div>
        </div>
      </Stack>
    </DataTableContextProvider>
  );
}

function SpacerRow({ height, columns }: { height: number; columns: number }) {
  return (
    <tr aria-hidden="true">
      <td style={{ height, padding: 0, border: 0 }} colSpan={Math.max(columns, 1)} />
    </tr>
  );
}

function useControlledSetter<T>(value: T, onChange: (next: T) => void): Dispatch<SetStateAction<T>> {
  return useCallback((nextValue) => {
    onChange(typeof nextValue === "function" ? (nextValue as (current: T) => T)(value) : nextValue);
  }, [onChange, value]);
}
