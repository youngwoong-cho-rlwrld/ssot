import type { Field } from "../enmight/types/apiTypes.ts";
import type { ColorStylerItemType, RowType } from "../enmight/types/layoutTypes.ts";
import { filterColumnIds, rowMatchesFilters } from "../enmight/utils/tables/filters.ts";
import { DEFAULT_TABLE_COLOR } from "./agentContract.mjs";

export {
  DEFAULT_TABLE_RULE_COLOR,
  normalizeTableColor,
  tableColorLabel,
  TABLE_COLORS,
  TABLE_COLOR_SWATCHES,
} from "./tablePalette.ts";

export { DEFAULT_TABLE_COLOR };

export function createTableColorResolver(rules: ColorStylerItemType[]) {
  const compiled = rules.map((rule) => ({
    rule,
    columnIds: rule.targetType === "cell" ? filterColumnIds(rule.filter) : null,
  }));
  const rowColorCache = new WeakMap<RowType, string | null>();

  return (header: Field, row: RowType): string | undefined => {
    const cellColor = compiled.find(({ rule, columnIds }) => (
      rule.color
      && rule.targetType === "cell"
      && columnIds?.has(header.id)
      && rowMatchesFilters(row, rule.filter)
    ))?.rule.color;
    if (cellColor) return cellColor;

    if (!rowColorCache.has(row)) {
      const rowColor = compiled.find(({ rule }) => (
        rule.color
        && rule.targetType === "row"
        && rowMatchesFilters(row, rule.filter)
      ))?.rule.color;
      rowColorCache.set(row, rowColor ?? null);
    }
    return rowColorCache.get(row) ?? undefined;
  };
}
