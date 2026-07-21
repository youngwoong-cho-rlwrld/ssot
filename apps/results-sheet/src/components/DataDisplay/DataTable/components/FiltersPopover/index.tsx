import * as Mantine from "@mantine/core";
import { IconFilter, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { Button } from "@enmight/baseComponents/Buttons/Button";
import Filters from "@enmight/baseComponents/DataDisplay/Filters/Filters";
import type { Filters as FiltersType } from "@enmight/types/filterTypes";
import {
  cloneFilters,
  finalizeEditedFilters,
  isEmptyFilter,
  isValidFilter,
} from "@enmight/utils/tables/filters";
import { useDataTableContext } from "../../context/DataTable.context";
import classes from "@/components/ResultsToolbarActions.module.css";

export default function FiltersPopover() {
  const { columns, appliedFilters, setAppliedFilters } = useDataTableContext();
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState<FiltersType>(() => cloneFilters(appliedFilters));
  const hasActiveFilters = !isEmptyFilter(appliedFilters);
  const invalid = !isEmptyFilter(draft) && !isValidFilter(draft);

  const open = () => {
    setDraft(cloneFilters(appliedFilters));
    setOpened(true);
  };
  const close = () => setOpened(false);
  const apply = () => {
    if (invalid) return;
    setAppliedFilters(finalizeEditedFilters(draft));
    setOpened(false);
  };

  return (
    <Mantine.Popover position="bottom-end" shadow="sm" opened={opened} onChange={setOpened} onClose={close}>
      <Mantine.Popover.Target>
        <Button
          size="compact-sm"
          leftSection={<IconFilter size={14} stroke={1.3} />}
          className={(hasActiveFilters || opened) ? classes.popoverButtonActive : classes.popoverButton}
          onClick={open}
        >
          Filter
        </Button>
      </Mantine.Popover.Target>
      <Mantine.Popover.Dropdown style={{ borderRadius: 4, padding: 0 }}>
        <Mantine.Stack p={16} gap={8}>
          <Mantine.ActionIcon aria-label="Close filter editor" variant="subtle" pos="absolute" top={15} right={15} onClick={close}>
            <IconX stroke={1.3} size={20} color="var(--text-secondary)" />
          </Mantine.ActionIcon>
          <Filters
            isInPopover
            columnOptions={columns}
            value={draft}
            onChange={setDraft}
          />
          <Mantine.Divider />
          <Mantine.Group justify="space-between">
            <Button size="compact-md" variant="subtle" onClick={close}>Cancel</Button>
            <Button size="compact-md" disabled={invalid} onClick={apply}>Apply</Button>
          </Mantine.Group>
        </Mantine.Stack>
      </Mantine.Popover.Dropdown>
    </Mantine.Popover>
  );
}
