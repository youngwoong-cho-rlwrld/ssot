type FieldComponent = "TEXT" | "NUMBER" | "BOOLEAN" | "DATETIME";

export type Field = {
  id: string;
  displayName: string;
  type: FieldComponent;
};
