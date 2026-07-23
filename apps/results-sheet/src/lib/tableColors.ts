import type { Field } from "../enmight/types/apiTypes.ts";
import type { ColorStylerItemType, RowType } from "../enmight/types/layoutTypes.ts";
import { filterColumnIds, rowMatchesFilters } from "../enmight/utils/tables/filters.ts";
import {
  DEFAULT_TABLE_COLOR,
  DEFAULT_TABLE_RULE_COLOR,
  TABLE_COLORS,
} from "./agentContract.mjs";

export { DEFAULT_TABLE_COLOR, DEFAULT_TABLE_RULE_COLOR, TABLE_COLORS };

export const TABLE_COLOR_SWATCHES = TABLE_COLORS.map((color) => color.value);

const COLOR_BY_VALUE = new Map(TABLE_COLORS.map((color) => [color.value.toLowerCase(), color]));
const COLOR_BY_LABEL = new Map(TABLE_COLORS.map((color) => [color.label.toLowerCase(), color]));

export function normalizeTableColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return COLOR_BY_VALUE.get(normalized)?.value ?? COLOR_BY_LABEL.get(normalized)?.value ?? null;
}

export function tableColorLabel(value: unknown): string {
  const normalized = normalizeTableColor(value);
  return normalized ? COLOR_BY_VALUE.get(normalized.toLowerCase())?.label ?? "" : "";
}

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
