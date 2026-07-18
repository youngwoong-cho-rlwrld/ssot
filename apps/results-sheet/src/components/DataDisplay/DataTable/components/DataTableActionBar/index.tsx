import { Flex } from "@mantine/core";
import type { ReactNode } from "react";
import ColorStylerPopover from "../ColorStylerPopover";
import ColumnTogglePopover from "../ColumnTogglePopover";
import FilterCombobox from "../FilterCombobox";
import FiltersPopover from "../FiltersPopover";
import SortByPopover from "../SortByPopover";

export default function DataTableActionBar({ actionGroups }: { actionGroups?: ReactNode[] }) {
  return (
    <Flex gap="sm" h={40}>
      <Flex style={{ flexGrow: 1 }} align="center" gap="sm">
        <FilterCombobox />
      </Flex>
      <Flex gap={10} align="center" style={{ whiteSpace: "nowrap" }}>
        <FiltersPopover />
        <SortByPopover />
        <ColumnTogglePopover />
        <ColorStylerPopover />
        {actionGroups}
      </Flex>
    </Flex>
  );
}
