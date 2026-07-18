import type { MantineSize } from "@mantine/core";
import type { Field } from "@enmight/types/apiTypes";
import {
  FormattedDatePickerInput,
  FormattedNumberInput,
  FormattedTextInput,
} from "@enmight/utils/formatters";

export type FilterInputValue = string | number | Date | Array<string | number> | null;

type FiltersInputProps = {
  field: Field | null;
  value: FilterInputValue;
  onChange: (value: FilterInputValue) => void;
  size?: MantineSize;
  withinPortal?: boolean;
};

export default function FiltersInput({
  field,
  value,
  onChange,
  size = "xs",
  withinPortal = false,
}: FiltersInputProps) {
  if (!field) {
    return <FormattedTextInput aria-label="Filter value" size={size} value="" placeholder="Enter value..." disabled />;
  }

  if (field.type === "NUMBER") {
    const numericValue = typeof value === "number" || typeof value === "string" ? value : "";
    return (
      <FormattedNumberInput
        aria-label="Filter value"
        size={size}
        value={numericValue}
        onChange={onChange}
        placeholder="Enter number..."
      />
    );
  }

  if (field.type === "DATETIME") {
    return (
      <FormattedDatePickerInput
        aria-label="Filter value"
        size={size}
        value={toDate(value)}
        onChange={onChange}
        placeholder="Select date..."
        valueFormat="MM/DD/YYYY"
        popoverProps={{ withinPortal }}
      />
    );
  }

  if (field.type === "BOOLEAN") {
    return null;
  }

  return (
    <FormattedTextInput
      aria-label="Filter value"
      size={size}
      value={Array.isArray(value)
        ? value.join(", ")
        : typeof value === "string" || typeof value === "number"
          ? String(value)
          : ""}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder="Type here..."
    />
  );
}

function toDate(value: FilterInputValue): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
