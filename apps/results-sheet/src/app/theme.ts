import {
  createTheme,
  type MantineTheme,
  type MantineThemeOverride,
  type MultiSelectProps,
  type SelectProps,
  type TextInputProps,
} from "@mantine/core";

export const theme: MantineThemeOverride = createTheme({
  fontFamily: "var(--ssot-font-sans)",
  colors: {
    // UI-chrome accent. Shade 5 is --ssot-accent, shade 6 is --ssot-accent-strong,
    // shade 0 is --ssot-accent-soft, matching the tokens.css indigo. This is the
    // Mantine primaryColor; the enmight ramps below remain for data visuals.
    "ssot-accent": [
      "#eef2ff",
      "#dfe5ff",
      "#c0ccff",
      "#9fb0fb",
      "#7089f9",
      "#4f6ef7",
      "#3b55d9",
      "#2f45b3",
      "#26398f",
      "#1e2d70",
    ],
    "enmight-green": [
      "#F4FAF8",
      "#D7EBE4",
      "#B3DACE",
      "#49BF91",
      "#17966C",
      "#008861",
      "#008861",
      "#008861",
      "#00452F",
      "#002C1D",
    ],
    "point-yellow": [
      "#FFF8F4",
      "#FFDCBB",
      "#FBBA73",
      "#FFB869",
      "#FFB054",
      "#FE9737",
      "#FF621F",
      "#E04820",
      "#AB3E21",
      "#845416",
    ],
    "enmight-gray": [
      "#F4F4F5",
      "#E4E4E7",
      "#D4D4D8",
      "#ADADB5",
      "#95959E",
      "#6F6F77",
      "#4D4D57",
      "#3B3B43",
      "#252528",
      "#18181B",
    ],
    "enmight-red": [
      "#FFAAAA",
      "#FF6D6D",
      "#FF4444",
      "#FE002E",
      "#F8002D",
      "#D91E3F",
      "#C51837",
      "#BA0425",
      "#A90E29",
      "#8F0C24",
    ],
  },
  primaryColor: "ssot-accent",
  primaryShade: { light: 5, dark: 6 },
  cursorType: "pointer",
  // SSOT type scale: headings render at semibold (600). Body/UI sizing stays on
  // Mantine defaults so the shared DataTable controls are not disturbed; the
  // non-DataTable panels size their text against the --ssot-text-* tokens.
  headings: {
    fontWeight: "600",
    sizes: {
      h1: { fontSize: "var(--ssot-text-xl)", fontWeight: "600" },
      h2: { fontSize: "var(--ssot-text-lg)", fontWeight: "600" },
      h3: { fontSize: "var(--ssot-text-md)", fontWeight: "600" },
      h4: { fontSize: "var(--ssot-text-sm)", fontWeight: "600" },
    },
  },
  breakpoints: {
    xs: "36em",
    sm: "48em",
    md: "62em",
    lg: "75em",
    xl: "94.5em",
  },
  components: {
    Text: {
      styles: {
        root: {
          color: "var(--text-primary)",
        },
      },
    },
    TextInput: {
      styles: (_theme: MantineTheme, prop: TextInputProps) => ({
        input: {
          backgroundColor: prop.variant === "unstyled" ? undefined : "var(--field-background)",
          borderColor: prop.error
            ? "var(--border-error)"
            : prop.variant === "unstyled"
              ? undefined
              : "var(--border-subtle-2)",
          borderRadius: prop.variant === "unstyled" ? 0 : "var(--input-radius)",
          fontSize: { xs: 14, sm: 16, md: 18, lg: 20, xl: 22 },
          fontWeight: 500,
          color: prop.error ? "var(--text-error)" : "var(--text-primary)",
        },
        option: {
          fontSize: 14,
        },
      }),
    },
    Select: {
      styles: (_theme: MantineTheme, prop: SelectProps) => ({
        input: {
          backgroundColor: "var(--field-background)",
          borderColor: prop.error ? "var(--border-error)" : "var(--border-subtle-2)",
          fontSize: { xs: 14, sm: 16, md: 18, lg: 20, xl: 22 },
          fontWeight: 500,
          padding: 8,
          color: prop.error ? "var(--text-error)" : "var(--text-primary)",
        },
        option: {
          fontSize: 14,
        },
      }),
    },
    MultiSelect: {
      styles: (_theme: MantineTheme, prop: MultiSelectProps) => ({
        input: {
          backgroundColor: "var(--field-background)",
          borderColor: prop.error ? "var(--border-error)" : "var(--border-subtle-2)",
          fontSize: { xs: 14, sm: 16, md: 18, lg: 20, xl: 22 },
          fontWeight: 500,
          padding: 8,
          color: prop.error ? "var(--text-error)" : "var(--text-primary)",
        },
        option: {
          fontSize: 14,
        },
      }),
    },
    Divider: {
      styles: {
        root: {
          "--divider-color": "var(--border-subtle-2)",
        },
      },
    },
  },
});
