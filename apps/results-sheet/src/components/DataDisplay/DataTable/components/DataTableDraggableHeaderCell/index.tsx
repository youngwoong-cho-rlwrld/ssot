import { CSS } from "@dnd-kit/utilities";
import { useSortable } from "@dnd-kit/sortable";
import { Flex } from "@mantine/core";
import DragHandle from "@enmight/baseComponents/Interaction/DragHandle/DragHandle";
import { Typography } from "@enmight/baseComponents/Typography/Typography";
import type { DataTableHeaderCellProps } from "../../types";
import styles from "../../DataTable.module.css";

export default function DataTableHeaderCell({
  header,
  width,
  resizingColumnId,
  onResizeStart,
}: DataTableHeaderCellProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: header.id,
  });
  const isResizing = resizingColumnId === header.id;

  return (
    <th
      ref={setNodeRef}
      className={styles.th}
      data-header-id={header.id}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 4 : 2,
        backgroundColor: "var(--background-gray-0-level-1)",
      }}
    >
      <Flex
        px={8}
        py={8}
        align="center"
        justify="space-between"
        wrap="nowrap"
        style={{ whiteSpace: "nowrap" }}
      >
        <Typography variant="label" size="lg" truncate c="var(--text-secondary)">
          {header.displayName}
        </Typography>
        <div
          aria-hidden="true"
          className={isResizing ? styles.isResizing : styles.resizer}
          onMouseDown={(event) => onResizeStart(header, event.pageX, width)}
        />
        <DragHandle
          {...attributes}
          {...listeners}
          className={styles.headerDragHandle}
        />
      </Flex>
    </th>
  );
}
