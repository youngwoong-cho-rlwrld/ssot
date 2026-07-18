import * as Mantine from "@mantine/core";
import { IconArrowsUpDown, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Button } from "@enmight/baseComponents/Buttons/Button";
import type { SortByItemType } from "@enmight/types/layoutTypes";
import SortBy from "../SortBy";
import { useDataTableContext } from "../../context/DataTable.context";
import classes from "@/components/ResultsToolbarActions.module.css";

export default function SortByPopover() {
  const { sortByItems, setSortByItems } = useDataTableContext();
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState<SortByItemType[]>(sortByItems);

  useEffect(() => {
    if (!opened) setDraft(sortByItems);
  }, [opened, sortByItems]);

  const activeRules = draft.filter(isCompleteSortRule);
  const invalid = draft.some((item) => Boolean(item.fieldId) !== Boolean(item.sortState));
  const close = () => {
    setDraft(sortByItems);
    setOpened(false);
  };
  const apply = () => {
    if (invalid) return;
    setSortByItems(activeRules);
    setOpened(false);
  };

  return (
    <Mantine.Popover position="bottom-end" shadow="sm" opened={opened} onChange={setOpened}>
      <Mantine.Popover.Target>
        <Button
          size="compact-sm"
          leftSection={<IconArrowsUpDown size={14} stroke={1.3} />}
          className={(sortByItems.length || opened) ? classes.popoverButtonActive : classes.popoverButton}
          onClick={() => setOpened((current) => !current)}
        >
          Sort {sortByItems.length ? `(${sortByItems.length})` : ""}
        </Button>
      </Mantine.Popover.Target>
      <Mantine.Popover.Dropdown style={{ borderRadius: 4, padding: 0 }}>
        <Mantine.Stack p={16} gap={12}>
          <Mantine.ActionIcon aria-label="Close sort editor" variant="subtle" pos="absolute" top={12} right={12} onClick={close}>
            <IconX stroke={1.3} size={20} color="var(--text-primary)" />
          </Mantine.ActionIcon>
          <SortBy newSortByItems={draft} setNewSortByItems={setDraft} />
          <Mantine.Group justify="space-between">
            <Button size="compact-md" variant="subtle" onClick={close}>Cancel</Button>
            <Button size="compact-md" disabled={invalid} onClick={apply}>Apply</Button>
          </Mantine.Group>
        </Mantine.Stack>
      </Mantine.Popover.Dropdown>
    </Mantine.Popover>
  );
}

function isCompleteSortRule(item: SortByItemType): item is SortByItemType & {
  fieldId: string;
  sortState: "asc" | "desc";
} {
  return Boolean(item.fieldId && item.sortState);
}
