import {
  ActionIcon,
  Divider,
  Flex,
  Group,
  Menu,
  SimpleGrid,
  Space,
  Stack,
} from "@mantine/core";
import { IconCheck, IconChevronDown, IconPlus, IconTrash } from "@tabler/icons-react";
import type { CSSProperties, ReactElement } from "react";
import { Button } from "@enmight/baseComponents/Buttons/Button";
import { Typography } from "@enmight/baseComponents/Typography/Typography";
import type { Field } from "@enmight/types/apiTypes";
import type {
  ColumnFilter,
  FilterConjunction,
  FilterNode,
  FilterOperator,
  Filters as FiltersType,
  NestedFilter,
} from "@enmight/types/filterTypes";
import { FormattedSelectInput } from "@enmight/utils/formatters";
import {
  createEmptyColumnFilter,
  createEmptyFilters,
  isNestedFilter,
  operatorRequiresValue,
  operatorsForField,
} from "@enmight/utils/tables/filters";
import { makeId } from "@/lib/id";
import FiltersInput, { type FilterInputValue } from "./components/FiltersInput";

type FiltersProps = {
  width?: CSSProperties["width"];
  columnOptions: Field[];
  value?: FiltersType;
  onChange?: (filters: FiltersType) => void;
  showTitle?: boolean;
  allowMultiple?: boolean;
  isInPopover?: boolean;
};

type FilterPath = readonly number[];

export function Filters({
  width,
  columnOptions,
  value = createEmptyFilters(),
  onChange,
  showTitle = true,
  allowMultiple = true,
  isInPopover = false,
}: FiltersProps) {
  const emit = (filterSet: FilterNode[], conjunction = value.filters.conjunction) => {
    onChange?.({
      ...value,
      filters: {
        conjunction,
        filterSet: filterSet.length ? filterSet : [createEmptyColumnFilter()],
      },
    });
  };

  const updateFilter = (path: FilterPath, update: (node: FilterNode) => FilterNode) => {
    emit(updateNodeAtPath(value.filters.filterSet, path, update));
  };

  const updateColumnFilter = (path: FilterPath, update: Partial<ColumnFilter>) => {
    updateFilter(path, (node) => isNestedFilter(node) ? node : { ...node, ...update });
  };

  const selectColumn = (path: FilterPath, columnId: string | null) => {
    const field = columnOptions.find((column) => column.id === columnId) ?? null;
    updateColumnFilter(path, {
      columnId: columnId ?? "",
      operator: operatorsForField(field)[0]?.value ?? "",
      value: null,
    });
  };

  const selectOperator = (path: FilterPath, operator: string | null, currentValue: unknown) => {
    const nextOperator = (operator ?? "") as FilterOperator | "";
    updateColumnFilter(path, {
      operator: nextOperator,
      value: operatorRequiresValue(nextOperator) ? currentValue : null,
    });
  };

  const addFilter = (containerPath: FilterPath) => {
    emit(appendNodeAtPath(value.filters.filterSet, containerPath, createEmptyColumnFilter()));
  };

  const addGroup = () => {
    const group: NestedFilter = {
      id: makeId("filter-group"),
      type: "nested",
      conjunction: value.filters.conjunction === "and" ? "or" : "and",
      filterSet: [createEmptyColumnFilter()],
    };
    emit([...value.filters.filterSet, group]);
  };

  const deleteFilter = (path: FilterPath) => {
    emit(removeNodeAtPath(value.filters.filterSet, path));
  };

  const changeConjunction = (containerPath: FilterPath, conjunction: FilterConjunction) => {
    if (!containerPath.length) {
      emit(value.filters.filterSet, conjunction);
      return;
    }
    updateFilter(containerPath, (node) => (
      isNestedFilter(node) ? { ...node, conjunction } : node
    ));
  };

  const renderColumnFilter = (filter: ColumnFilter, path: number[]): ReactElement => {
    const selectedColumn = columnOptions.find((column) => column.id === filter.columnId) ?? null;
    const isOnlyEmptyRootFilter = path.length === 1 &&
      value.filters.filterSet.length === 1 &&
      (!filter.columnId || !filter.operator);

    return (
      <Group w="100%" gap={14}>
        <SimpleGrid cols={3} flex={1} spacing={14}>
          <FormattedSelectInput
            aria-label="Filter column"
            size="xs"
            flex={1}
            placeholder="Select column..."
            data={columnOptions.map((column) => ({ value: column.id, label: column.displayName }))}
            value={filter.columnId || null}
            onChange={(columnId) => selectColumn(path, columnId)}
            comboboxProps={{ withinPortal: false }}
            allowDeselect
          />
          <FormattedSelectInput
            aria-label="Filter operator"
            size="xs"
            flex={1}
            placeholder="Select operation..."
            data={operatorsForField(selectedColumn)}
            value={filter.operator || null}
            onChange={(operator) => selectOperator(path, operator, filter.value)}
            disabled={!filter.columnId}
            comboboxProps={{ withinPortal: false }}
            allowDeselect={false}
          />
          <FiltersInput
            size="xs"
            field={selectedColumn}
            value={filter.value as FilterInputValue}
            onChange={(nextValue) => updateColumnFilter(path, { value: nextValue })}
            withinPortal={false}
          />
        </SimpleGrid>
        {allowMultiple && (
          <ActionIcon
            aria-label="Remove filter"
            onClick={() => deleteFilter(path)}
            variant="subtle"
            c="var(--button-secondary)"
            disabled={isOnlyEmptyRootFilter}
            size={20}
          >
            <IconTrash size={16} stroke={1.3} />
          </ActionIcon>
        )}
      </Group>
    );
  };

  const renderFilters = (
    filterSet: FilterNode[],
    conjunction: FilterConjunction,
    containerPath: number[] = [],
  ): ReactElement => (
    <Stack gap={8} w="100%">
      {filterSet.map((filter, index) => {
        const path = [...containerPath, index];
        return (
          <div key={filter.id} style={{ display: "flex", width: "100%" }}>
            {filterSet.length >= 2 && index === 1 && (
              <ConjunctionMenu
                conjunction={conjunction}
                onChange={(next) => changeConjunction(containerPath, next)}
              />
            )}
            {filterSet.length >= 2 && index > 1 && <Space w={65} />}
            {isNestedFilter(filter) ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  width: "100%",
                  backgroundColor: "var(--background-gray-0-level-1)",
                  borderRadius: 4,
                  padding: 8,
                }}
              >
                {renderFilters(filter.filterSet, filter.conjunction, path)}
                {allowMultiple && (
                  <Group gap={4}>
                    <Button
                      size="compact-sm"
                      onClick={() => addFilter(path)}
                      variant="subtle"
                      c="var(--text-primary)"
                      leftSection={<IconPlus size={14} stroke={1.3} />}
                    >
                      Add Filter
                    </Button>
                  </Group>
                )}
              </div>
            ) : renderColumnFilter(filter, path)}
          </div>
        );
      })}
    </Stack>
  );

  return (
    <Stack w={width ?? 640} gap={0}>
      <Group justify={showTitle ? "space-between" : "flex-end"}>
        {showTitle && <Typography variant="body" size="sm">Filter</Typography>}
        {allowMultiple && (
          <Button
            variant="subtle"
            size="compact-sm"
            onClick={() => onChange?.(createEmptyFilters())}
            mr={isInPopover ? 32 : 0}
          >
            Clear All
          </Button>
        )}
      </Group>
      {showTitle && <Divider mt={6} mb={12} />}

      <Flex w="100%" h="100%" align="flex-start" gap={16}>
        <Stack gap="xs" flex={1}>
          {renderFilters(value.filters.filterSet, value.filters.conjunction)}
          {allowMultiple && (
            <Group gap={4}>
              <Button
                size="compact-sm"
                onClick={() => addFilter([])}
                variant="subtle"
                c="var(--text-primary)"
                leftSection={<IconPlus size={14} stroke={1.3} />}
              >
                Add Filter
              </Button>
              <Button
                size="compact-sm"
                onClick={addGroup}
                variant="subtle"
                c="var(--text-primary)"
                leftSection={<IconPlus size={14} stroke={1.3} />}
              >
                Add Filter Group
              </Button>
            </Group>
          )}
        </Stack>
      </Flex>
    </Stack>
  );
}

function ConjunctionMenu({
  conjunction,
  onChange,
}: {
  conjunction: FilterConjunction;
  onChange: (value: FilterConjunction) => void;
}) {
  return (
    <Menu position="bottom-start" withinPortal={false}>
      <Menu.Target>
        <Button
          size="xs"
          variant="subtle"
          c="var(--text-primary)"
          rightSection={<IconChevronDown size={14} stroke={1.3} />}
          styles={{
            root: {
              height: 24,
              minWidth: 52,
              marginTop: 3,
              marginRight: 12,
              padding: 0,
              border: "1px solid var(--text-green)",
              borderRadius: 10,
              backgroundColor: "var(--background-green-0-level-1)",
            },
            inner: { width: "100%", padding: "4px 4px 4px 8px", justifyContent: "space-between" },
            section: { padding: 0, width: 10, margin: 0, color: "var(--text-green)" },
            label: { fontSize: 13, fontWeight: 500, color: "var(--text-green)" },
          }}
        >
          {conjunction.toUpperCase()}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {(["and", "or"] as const).map((value) => (
          <Menu.Item key={value} p="2px 4px" onClick={() => onChange(value)}>
            <Flex align="center" gap={6}>
              {value.toUpperCase()}
              {conjunction === value && <IconCheck size={12} stroke={1.3} />}
            </Flex>
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

function updateNodeAtPath(
  nodes: FilterNode[],
  path: FilterPath,
  update: (node: FilterNode) => FilterNode,
): FilterNode[] {
  if (!path.length) return nodes;
  const [index, ...rest] = path;
  return nodes.map((node, nodeIndex) => {
    if (nodeIndex !== index) return node;
    if (!rest.length) return update(node);
    if (!isNestedFilter(node)) return node;
    return { ...node, filterSet: updateNodeAtPath(node.filterSet, rest, update) };
  });
}

function appendNodeAtPath(nodes: FilterNode[], path: FilterPath, node: FilterNode): FilterNode[] {
  if (!path.length) return [...nodes, node];
  return updateNodeAtPath(nodes, path, (target) => (
    isNestedFilter(target) ? { ...target, filterSet: [...target.filterSet, node] } : target
  ));
}

function removeNodeAtPath(nodes: FilterNode[], path: FilterPath): FilterNode[] {
  if (!path.length) return nodes;
  const [index, ...rest] = path;
  if (!rest.length) return nodes.filter((_, nodeIndex) => nodeIndex !== index);

  return nodes.flatMap((node, nodeIndex): FilterNode[] => {
    if (nodeIndex !== index || !isNestedFilter(node)) return [node];
    const filterSet = removeNodeAtPath(node.filterSet, rest);
    return filterSet.length ? [{ ...node, filterSet }] : [];
  });
}

export default Filters;
