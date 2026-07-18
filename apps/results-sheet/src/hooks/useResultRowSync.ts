import { useCallback, useEffect, useState } from "react";

export function useResultRowSync(validRowIds: string[]) {
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const validIds = new Set(validRowIds);
    setSelectedRowIds((current) => {
      const next = new Set([...current].filter((rowId) => validIds.has(rowId)));
      return next.size === current.size ? current : next;
    });
    setHoveredRowId((current) => current && validIds.has(current) ? current : null);
  }, [validRowIds]);

  const handleRowToggle = useCallback((rowId: string) => {
    setSelectedRowIds((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }, []);

  return {
    hoveredRowId,
    selectedRowIds,
    handleRowHover: setHoveredRowId,
    handleRowToggle,
  };
}
