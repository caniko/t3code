import type { OperatorRequestField } from "@t3tools/contracts";

export type FieldValue = string | boolean | ReadonlyArray<string>;

export function initialFieldValue(field: OperatorRequestField): FieldValue | undefined {
  const value = field.defaultValue;
  const hasOption = (value: unknown): value is string =>
    typeof value === "string" && (field.options?.some((option) => option.value === value) ?? false);
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "multiselect":
      return Array.isArray(value) ? value.filter(hasOption) : [];
    case "select":
      return hasOption(value) ? value : "";
    default:
      return typeof value === "string" ? value : "";
  }
}

export function firstMissingField(
  fields: ReadonlyArray<OperatorRequestField>,
  answers: Readonly<Record<string, FieldValue | undefined>>,
) {
  return fields.find((field) => {
    const value = answers[field.id];
    return (
      field.required &&
      (value === undefined ||
        (typeof value === "string" && value.trim() === "") ||
        (Array.isArray(value) && value.length === 0))
    );
  });
}
