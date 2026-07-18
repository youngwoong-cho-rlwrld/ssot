export const COLOR_PALETTE_48 = [
  "#2671d9",
  "#e0525e",
  "#2f9d7e",
  "#d28f22",
  "#7c5ac7",
  "#de4f9a",
  "#4b89a7",
  "#8b8f3a",
  "#c65f31",
  "#5367b7",
  "#111827",
  "#4b5563",
  "#9ca3af",
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#d946ef",
  "#ec4899",
  "#f43f5e",
  "#7f1d1d",
  "#9a3412",
  "#854d0e",
  "#713f12",
  "#3f6212",
  "#166534",
  "#065f46",
  "#115e59",
  "#155e75",
  "#075985",
  "#1d4ed8",
  "#3730a3",
  "#5b21b6",
  "#86198f",
  "#9d174d",
  "#be123c",
  "#fca5a5",
  "#fdba74",
];

export const UNGROUPED_JOINT_COLOR = "#9ca3af";

export function colorForIndex(index: number): string {
  return COLOR_PALETTE_48[index % COLOR_PALETTE_48.length];
}

export function normalizeHexColor(value: string, fallback = "#2671d9"): string {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return fallback;
}
