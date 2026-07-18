import * as Mantine from "@mantine/core";
import { IconPalette, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Button } from "@enmight/baseComponents/Buttons/Button";
import type { ColorStylerItemType } from "@enmight/types/layoutTypes";
import { isEmptyFilter, isValidFilter } from "@enmight/utils/tables/filters";
import ColorStyler from "../ColorStyler";
import { useDataTableContext } from "../../context/DataTable.context";
import classes from "@/components/ResultsToolbarActions.module.css";

export default function ColorStylerPopover() {
  const { colorStylerItems, setColorStylerItems } = useDataTableContext();
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState<ColorStylerItemType[]>(colorStylerItems);

  useEffect(() => {
    if (!opened) setDraft(colorStylerItems);
  }, [colorStylerItems, opened]);

  const invalid = draft.some((item) => !isEmptyRule(item) && !isValidRule(item));
  const close = () => {
    setDraft(colorStylerItems);
    setOpened(false);
  };
  const apply = () => {
    if (invalid) return;
    setColorStylerItems(draft.filter(isValidRule));
    setOpened(false);
  };

  return (
    <Mantine.Popover position="bottom-end" shadow="sm" opened={opened} onChange={setOpened}>
      <Mantine.Popover.Target>
        <Button
          size="compact-sm"
          leftSection={<IconPalette size={14} stroke={1.3} />}
          className={(colorStylerItems.length || opened) ? classes.popoverButtonActive : classes.popoverButton}
          onClick={() => setOpened((current) => !current)}
        >
          Color {colorStylerItems.length ? `(${colorStylerItems.length})` : ""}
        </Button>
      </Mantine.Popover.Target>
      <Mantine.Popover.Dropdown style={{ borderRadius: 4, padding: 0 }}>
        <Mantine.Stack p={16} gap={12}>
          <Mantine.ActionIcon aria-label="Close color editor" variant="subtle" pos="absolute" top={12} right={12} onClick={close}>
            <IconX stroke={1.3} size={20} color="var(--text-primary)" />
          </Mantine.ActionIcon>
          <ColorStyler newColorStylerItems={draft} setNewColorStylerItems={setDraft} />
          <Mantine.Group justify="space-between">
            <Button size="compact-md" variant="subtle" onClick={close}>Cancel</Button>
            <Button size="compact-md" disabled={invalid} onClick={apply}>Apply</Button>
          </Mantine.Group>
        </Mantine.Stack>
      </Mantine.Popover.Dropdown>
    </Mantine.Popover>
  );
}

function isEmptyRule(item: ColorStylerItemType) {
  return !item.color && !item.targetType && isEmptyFilter(item.filter);
}

function isValidRule(item: ColorStylerItemType): item is ColorStylerItemType & {
  targetType: "row" | "cell";
} {
  return Boolean(item.color && item.targetType && isValidFilter(item.filter));
}
