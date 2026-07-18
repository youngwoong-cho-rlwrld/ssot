import * as Mantine from "@mantine/core";
import { Button } from "@enmight/baseComponents/Buttons/Button";
import { Typography } from "@enmight/baseComponents/Typography/Typography";
import {
  createEmptyFilters,
  extractConjunctionsFromFilters,
  keepOnlyFilterSource,
  removeSearchFiltersForColumn,
  separateFilters,
} from "@enmight/utils/tables/filters";
import { useDataTableContext } from "../../context/DataTable.context";

export default function FilterCombobox() {
  const combobox = Mantine.useCombobox();
  const { appliedFilters, setAppliedFilters, columns } = useDataTableContext();
  const { hasAdvancedFilter, searchFilters } = separateFilters(appliedFilters);
  const flattened = extractConjunctionsFromFilters(appliedFilters);
  const conjunctionById = new Map(flattened.map((filter) => [filter.id, filter._nestedParentConjunction ?? "or"]));

  const searchGroups = searchFilters.reduce((groups, filter) => {
    const column = columns.find((candidate) => candidate.id === filter.columnId);
    if (!column) return groups;
    const group = groups.get(column.id) ?? { label: column.displayName, values: [] as string[], conjunction: "or" };
    group.values.push(String(filter.value));
    group.conjunction = conjunctionById.get(filter.id) ?? group.conjunction;
    groups.set(column.id, group);
    return groups;
  }, new Map<string, { label: string; values: string[]; conjunction: string }>());

  const active = hasAdvancedFilter || searchGroups.size > 0;
  if (!active) return <div />;

  return (
    <Mantine.Flex align="center" gap={8} style={{ whiteSpace: "nowrap" }}>
      <Mantine.Combobox store={combobox}>
        <Mantine.Combobox.DropdownTarget>
          <Mantine.PillsInput w="100%" variant="unstyled" size="lg">
            <Mantine.Flex py={2} gap="sm" align="center">
              {hasAdvancedFilter && (
                <Mantine.Pill
                  size="lg"
                  withRemoveButton
                  onRemove={() => setAppliedFilters(keepOnlyFilterSource(appliedFilters, "search"))}
                  style={{
                    color: "var(--text-green)",
                    backgroundColor: "var(--background-lightgreen)",
                    border: "1px solid var(--text-green)",
                    borderRadius: 4,
                    paddingLeft: 6,
                    fontSize: 14,
                    cursor: "default",
                  }}
                >
                  <Typography variant="label" size="lg" mt={2} c="var(--text-green)">Advanced Filter</Typography>
                </Mantine.Pill>
              )}
              {[...searchGroups.entries()].map(([columnId, group]) => (
                <Mantine.Pill
                  key={columnId}
                  size="lg"
                  withRemoveButton
                  onRemove={() => setAppliedFilters(removeSearchFiltersForColumn(appliedFilters, columnId))}
                  style={{
                    color: "var(--text-secondary)",
                    backgroundColor: "var(--field-1)",
                    border: "1px solid var(--text-secondary)",
                    borderRadius: 4,
                    paddingLeft: 6,
                    fontSize: 14,
                    cursor: "default",
                  }}
                >
                  <Typography variant="label" size="lg" mt={2} c="var(--text-secondary)">
                    {group.label}: {group.values.join(` ${group.conjunction.toLowerCase()} `)}
                  </Typography>
                </Mantine.Pill>
              ))}
              <Button variant="subtle" size="compact-xs" onClick={() => setAppliedFilters(createEmptyFilters())}>
                Clear All
              </Button>
            </Mantine.Flex>
          </Mantine.PillsInput>
        </Mantine.Combobox.DropdownTarget>
      </Mantine.Combobox>
    </Mantine.Flex>
  );
}
