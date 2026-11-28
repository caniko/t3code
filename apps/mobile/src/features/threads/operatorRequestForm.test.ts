import type { OperatorRequestField } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { firstMissingField, initialFieldValue } from "./operatorRequestForm";

it("rejects empty required fields and submits typed defaults without coercion", () => {
  const fields = [
    { id: "name", label: "Name", type: "text", required: true, defaultValue: "  " },
    { id: "details", label: "Details", type: "textarea", defaultValue: "notes" },
    { id: "ok", label: "OK", type: "boolean", required: true, defaultValue: false },
    {
      id: "target",
      label: "Target",
      type: "select",
      required: true,
      options: [{ value: "one", label: "One" }],
      defaultValue: "invalid",
    },
    {
      id: "files",
      label: "Files",
      type: "multiselect",
      required: true,
      options: [{ value: "a", label: "A" }],
      defaultValue: ["a", "invalid", false],
    },
  ] satisfies OperatorRequestField[];
  const answers = Object.fromEntries(fields.map((field) => [field.id, initialFieldValue(field)]));
  expect(answers).toEqual({ name: "  ", details: "notes", ok: false, target: "", files: ["a"] });
  expect(firstMissingField(fields, answers)?.id).toBe("name");
  expect(firstMissingField(fields, { ...answers, name: "Agent" })?.id).toBe("target");
  expect(
    firstMissingField(fields, { ...answers, name: "Agent", target: "one", files: [] })?.id,
  ).toBe("files");
  expect(firstMissingField(fields, { ...answers, name: "Agent", target: "one" })).toBeUndefined();
});

it("requires an explicit answer for a required boolean without a default", () => {
  const field = { id: "permit", label: "Permit?", type: "boolean", required: true } as const;
  expect(firstMissingField([field], { permit: initialFieldValue(field) })).toBe(field);
  expect(firstMissingField([field], { permit: false })).toBeUndefined();
});
