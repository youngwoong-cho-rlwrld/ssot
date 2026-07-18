import {
  DEFAULT_TABLE_RULE_COLOR,
  TABLE_COLORS,
} from "./agentContract.mjs";

export { DEFAULT_TABLE_RULE_COLOR, TABLE_COLORS };

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
