import { useDataTableContext } from "../../context/DataTable.context";
import type { DataTableCellProps } from "../../types";
import styles from "../../DataTable.module.css";

export default function DataTableCell({ header, row, rowHeight }: DataTableCellProps) {
  const { resolveColor } = useDataTableContext();
  const color = resolveColor(header, row);

  return (
    <td
      className={styles.td}
      style={{
        height: rowHeight,
        backgroundColor: color,
      }}
    >
      <div className={styles.cellContent}>
        {formatCellValue(row[header.id])}
      </div>
    </td>
  );
}

function formatCellValue(value: string | number | boolean | null | undefined) {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  return value;
}
