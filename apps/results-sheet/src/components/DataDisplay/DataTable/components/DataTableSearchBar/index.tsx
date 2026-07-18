import * as Mantine from "@mantine/core";
import { IconFileDownload, IconPrinter, IconSearch } from "@tabler/icons-react";
import { useState } from "react";
import type { Field } from "@enmight/types/apiTypes";
import { addSearchFilter } from "@enmight/utils/tables/filters";
import SearchOrderPopover from "../DataTableToolBox/SearchOrderPopover";
import { useDataTableContext } from "../../context/DataTable.context";

export default function DataTableSearchBar() {
  const combobox = Mantine.useCombobox();
  const [value, setValue] = useState("");
  const { appliedFilters, setAppliedFilters, searchColumns } = useDataTableContext();

  const addSearch = (column: Field) => {
    const next = addSearchFilter(appliedFilters, column.id, value);
    if (next === appliedFilters) return;
    setAppliedFilters(next);
    setValue("");
    combobox.closeDropdown();
  };

  const submitFirst = () => {
    if (value.trim() && searchColumns[0]) addSearch(searchColumns[0]);
  };

  return (
    <Mantine.Group w="100%" h="100%" justify="space-between" bg="var(--background-white-level-0)">
      <Mantine.Combobox store={combobox} withinPortal={false} onOptionSubmit={(columnId) => {
        const column = searchColumns.find((candidate) => candidate.id === columnId);
        if (column) addSearch(column);
      }}>
        <Mantine.Combobox.Target>
          <Mantine.TextInput
            aria-label="Search results"
            leftSection={<IconSearch size={16} stroke={1.3} color="var(--text-placeholder)" />}
            variant="unstyled"
            placeholder="Search items or filters..."
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              combobox.openDropdown();
            }}
            onClick={() => combobox.openDropdown()}
            onFocus={() => combobox.openDropdown()}
            onBlur={() => combobox.closeDropdown()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitFirst();
              }
            }}
            style={{ position: "relative", top: 1, border: "1px solid var(--border-subtle-2)" }}
            w="100%"
            pr={10}
            h="100%"
            flex={1}
            styles={{ input: { backgroundColor: "var(--background-white-level-0)" } }}
          />
        </Mantine.Combobox.Target>
        <Mantine.Combobox.Dropdown hidden={!value.trim()}>
          <Mantine.Combobox.Options>
            {searchColumns.map((column) => (
              <Mantine.Combobox.Option key={column.id} value={column.id}>
                Search <strong>{column.displayName}</strong> for: <strong>{value}</strong>
              </Mantine.Combobox.Option>
            ))}
            {!searchColumns.length && <Mantine.Combobox.Empty>Nothing found</Mantine.Combobox.Empty>}
          </Mantine.Combobox.Options>
        </Mantine.Combobox.Dropdown>
      </Mantine.Combobox>
      <Mantine.Group w={152} pos="absolute" right={0} justify="flex-end">
        <Mantine.Group gap={8} px={8}>
          <SearchOrderPopover />
          <Mantine.ActionIcon aria-label="Download" variant="subtle" c="var(--button-secondary)">
            <IconFileDownload size={20} stroke={1.3} />
          </Mantine.ActionIcon>
          <Mantine.ActionIcon aria-label="Print" variant="subtle" c="var(--button-secondary)">
            <IconPrinter size={20} stroke={1.3} />
          </Mantine.ActionIcon>
        </Mantine.Group>
      </Mantine.Group>
    </Mantine.Group>
  );
}
