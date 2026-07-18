import {
  ColorInput,
  NumberInput,
  Select,
  TextInput,
  type ColorInputProps,
  type NumberInputProps,
  type SelectProps,
  type TextInputProps,
} from "@mantine/core";
import { DateInput, type DateInputProps } from "@mantine/dates";
import type { CSSProperties, ReactNode } from "react";

type InputStyleProps = {
  disabled?: boolean;
  error?: ReactNode;
  variant?: string;
};

function inputStyles(props: InputStyleProps, hideText = false) {
  return {
    input: {
      backgroundColor: props.variant === "unstyled"
        ? "transparent"
        : props.disabled
          ? "var(--background-gray-1-level-1)"
          : "var(--background-white-level-1)",
      borderColor: props.variant === "unstyled"
        ? "transparent"
        : props.disabled
          ? "var(--border-disabled)"
          : props.error
            ? "var(--border-error)"
            : "var(--border-subtle-2)",
      fontSize: hideText ? 0 : 16,
      fontWeight: 500,
      padding: 8,
      color: props.disabled
        ? "var(--text-disabled)"
        : props.error
          ? "var(--text-error)"
          : "var(--text-primary)",
    },
    option: { fontSize: 14 },
    error: { color: "var(--text-error)" },
  };
}

export function FormattedSelectInput(props: SelectProps) {
  const { styles: customStyles, ...rest } = props;
  return (
    <Select
      {...rest}
      size={rest.size ?? "sm"}
      styles={{ ...inputStyles(rest), ...(typeof customStyles === "object" ? customStyles : {}) }}
    />
  );
}

export function FormattedTextInput(props: TextInputProps) {
  const { styles: customStyles, ...rest } = props;
  return (
    <TextInput
      {...rest}
      size={rest.size ?? "sm"}
      styles={{ ...inputStyles(rest), ...(typeof customStyles === "object" ? customStyles : {}) }}
    />
  );
}

export function FormattedNumberInput(props: NumberInputProps) {
  const { styles: customStyles, ...rest } = props;
  return (
    <NumberInput
      {...rest}
      size={rest.size ?? "sm"}
      hideControls
      styles={{ ...inputStyles(rest), ...(typeof customStyles === "object" ? customStyles : {}) }}
    />
  );
}

export function FormattedDatePickerInput(props: DateInputProps) {
  const { styles: customStyles, ...rest } = props;
  return (
    <DateInput
      {...rest}
      size={rest.size ?? "sm"}
      valueFormat={rest.valueFormat ?? "MM/DD/YYYY"}
      styles={{ ...inputStyles(rest), ...(typeof customStyles === "object" ? customStyles : {}) }}
    />
  );
}

export function FormattedColorInput(props: ColorInputProps) {
  const { styles: customStyles, ...rest } = props;
  const baseStyles = inputStyles(rest, Boolean(rest.value));
  // Forward Mantine's own `disallowInput` (in ...rest) rather than mapping it
  // to `readOnly`: `readOnly` also disables the swatch dropdown, whereas
  // `disallowInput` only blocks typing and keeps swatch selection working.
  return (
    <ColorInput
      {...rest}
      size={rest.size ?? "sm"}
      styles={(theme) => {
        const overrides = typeof customStyles === "function"
          ? customStyles(theme, rest, undefined as never)
          : customStyles ?? {};
        return {
          ...baseStyles,
          ...overrides,
          input: {
            ...baseStyles.input,
            ...((overrides as { input?: CSSProperties }).input ?? {}),
          },
        };
      }}
    />
  );
}
