import * as Mantine from "@mantine/core";
import { IconEyeOff, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Button } from "@enmight/baseComponents/Buttons/Button";
import { Typography } from "@enmight/baseComponents/Typography/Typography";
import { useDataTableContext } from "../../context/DataTable.context";
import classes from "@/components/ResultsToolbarActions.module.css";

export default function ColumnTogglePopover() {
  const { columns, visibleColumns, setVisibleColumnIds, resetColumns } = useDataTableContext();
  const [opened, setOpened] = useState(false);
  const [draftIds, setDraftIds] = useState(() => visibleColumns.map((column) => column.id));

  useEffect(() => {
    if (!opened) setDraftIds(visibleColumns.map((column) => column.id));
  }, [opened, visibleColumns]);

  const close = () => {
    setDraftIds(visibleColumns.map((column) => column.id));
    setOpened(false);
  };
  const apply = () => {
    setVisibleColumnIds(draftIds);
    setOpened(false);
  };
  const reset = () => {
    resetColumns();
    setOpened(false);
  };
  const hasHiddenColumns = visibleColumns.length !== columns.length;

  return (
    <Mantine.Popover opened={opened} onChange={setOpened} position="bottom-end" onClose={close}>
      <Mantine.Popover.Target>
        <Button
          size="compact-sm"
          leftSection={<IconEyeOff size={14} stroke={1.3} />}
          className={(hasHiddenColumns || opened) ? classes.popoverButtonActive : classes.popoverButton}
          onClick={() => setOpened((current) => !current)}
        >
          Hide
        </Button>
      </Mantine.Popover.Target>
      <Mantine.Popover.Dropdown style={{ borderRadius: 4, padding: 0 }} miw={220}>
        <Mantine.Stack p={16} gap={12}>
          <Mantine.Group pos="absolute" top={12} right={12}>
            <Mantine.ActionIcon aria-label="Close column editor" variant="subtle" onClick={close}>
              <IconX stroke={1.3} size={20} color="var(--text-primary)" />
            </Mantine.ActionIcon>
          </Mantine.Group>
          <Mantine.Stack gap={0}>
            <Typography variant="label" size="lg">Show/Hide Columns</Typography>
            <Mantine.Divider mt={6} mb={12} />
            <Mantine.Checkbox.Group value={draftIds} onChange={setDraftIds}>
              <Mantine.Stack gap="xs" mah={240} style={{ overflow: "auto" }}>
                {columns.map((column) => (
                  <Mantine.Checkbox key={column.id} size="sm" value={column.id} label={column.displayName} />
                ))}
              </Mantine.Stack>
            </Mantine.Checkbox.Group>
            <Mantine.Divider mt={12} mb={0} />
          </Mantine.Stack>
          <Mantine.Button size="compact-sm" onClick={apply} disabled={!draftIds.length}>Apply</Mantine.Button>
          <Mantine.Button size="compact-sm" variant="subtle" onClick={reset}>Revert to Default</Mantine.Button>
        </Mantine.Stack>
      </Mantine.Popover.Dropdown>
    </Mantine.Popover>
  );
}
