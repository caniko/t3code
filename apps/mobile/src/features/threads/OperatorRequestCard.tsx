import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createOperatorRequestEnvironmentAtoms } from "@t3tools/client-runtime/state/operator-requests";
import {
  isOperatorRequestTerminalStatus,
  type EnvironmentId,
  type OperatorRequestAnswerInput,
  type OperatorRequestField,
  type OperatorRequestRecord,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { firstMissingField, initialFieldValue, type FieldValue } from "./operatorRequestForm";

const commands = createOperatorRequestEnvironmentAtoms(connectionAtomRuntime);
const inputClass = "rounded-lg border border-border px-3 py-2 text-foreground";

function RequestField({
  field,
  value,
  disabled,
  onChange,
}: {
  readonly field: OperatorRequestField;
  readonly value: FieldValue | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: FieldValue) => void;
}) {
  const label = field.required ? `${field.label} (required)` : field.label;
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">{label}</Text>
      {field.type === "boolean" ? (
        <View accessibilityRole="radiogroup" accessibilityLabel={label} className="flex-row gap-2">
          {([true, false] as const).map((choice) => (
            <Pressable
              key={String(choice)}
              accessibilityRole="radio"
              accessibilityState={{ checked: value === choice, disabled }}
              disabled={disabled}
              className={inputClass}
              onPress={() => onChange(choice)}
            >
              <Text className="text-foreground">
                {value === choice ? "✓ " : ""}
                {choice ? "Yes" : "No"}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : field.type === "select" || field.type === "multiselect" ? (
        (field.options ?? []).map((option) => {
          const selected = Array.isArray(value)
            ? value.includes(option.value)
            : value === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole={field.type === "select" ? "radio" : "checkbox"}
              accessibilityState={{ checked: selected, disabled }}
              disabled={disabled}
              className={inputClass}
              onPress={() =>
                onChange(
                  Array.isArray(value)
                    ? selected
                      ? value.filter((entry) => entry !== option.value)
                      : [...value, option.value]
                    : option.value,
                )
              }
            >
              <Text className="text-foreground">
                {selected ? "✓ " : ""}
                {option.label}
              </Text>
              {option.description ? (
                <Text className="text-foreground-muted">{option.description}</Text>
              ) : null}
            </Pressable>
          );
        })
      ) : (
        <TextInput
          accessibilityLabel={label}
          className={inputClass}
          editable={!disabled}
          value={typeof value === "string" ? value : ""}
          multiline={field.type === "textarea"}
          onChangeText={onChange}
        />
      )}
    </View>
  );
}

export function OperatorRequestCard({
  environmentId,
  request,
  local,
}: {
  readonly environmentId: EnvironmentId;
  readonly request: OperatorRequestRecord;
  readonly local: boolean;
}) {
  const { surfaces, requestId, threadId, turnItemId } = request;
  const form = surfaces?.inlineForm;
  const fields = form?.fields ?? [];
  const [answers, setAnswers] = useState<Record<string, FieldValue>>(() =>
    Object.fromEntries(
      fields.flatMap((field) => {
        const value = initialFieldValue(field);
        return value === undefined ? [] : [[field.id, value] as const];
      }),
    ),
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [resolved, setResolved] = useState<OperatorRequestRecord>();
  const display = isOperatorRequestTerminalStatus(request.status) ? request : (resolved ?? request);
  const terminal = isOperatorRequestTerminalStatus(display.status);
  const answer = useAtomCommand(commands.answer, { reportFailure: false });
  const cancel = useAtomCommand(commands.cancel, { reportFailure: false });
  const canAnswer = useAtomValue(commands.answer.permissionAtom(environmentId));
  const canCancel = useAtomValue(commands.cancel.permissionAtom(environmentId));
  const target = { requestId, threadId, turnItemId };

  async function run(input?: OperatorRequestAnswerInput) {
    setBusy(true);
    setError(undefined);
    const result = await (
      input === undefined
        ? cancel({ environmentId, input: target })
        : answer({ environmentId, input: { ...target, decidedVia: "inline", ...input } })
    ).finally(() => setBusy(false));
    if (result._tag === "Success") setResolved(result.value);
    else if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not update the operator request.");
    }
  }

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-base text-foreground">{request.title}</Text>
      {request.reason ? <Text className="text-foreground-muted">{request.reason}</Text> : null}
      {terminal ? (
        <Text className="text-foreground-muted">
          {display.status}
          {display.receipt ? ` · ${display.receipt.decidedVia}` : ""}
          {display.receipt?.summary ? `\n${display.receipt.summary}` : ""}
        </Text>
      ) : (
        <>
          {surfaces?.cliCommand ? (
            <Text selectable className="font-mono text-foreground">
              {surfaces.cliCommand}
            </Text>
          ) : null}
          {local && canAnswer && form ? (
            <>
              {form.quickActions?.map((action) => (
                <Button
                  key={action.id}
                  label={action.label}
                  tone={action.style}
                  disabled={busy}
                  onPress={() =>
                    void run({
                      status: "submitted",
                      actionId: action.id,
                      answers: action.payload,
                    })
                  }
                />
              ))}
              {fields.map((field) => (
                <RequestField
                  key={field.id}
                  field={field}
                  value={answers[field.id] ?? initialFieldValue(field)}
                  disabled={busy}
                  onChange={(value) =>
                    setAnswers((previous) => ({ ...previous, [field.id]: value }))
                  }
                />
              ))}
              {form.allowFreeformNote ? (
                <TextInput
                  accessibilityLabel="Note (optional)"
                  placeholder="Note (optional)"
                  className={inputClass}
                  editable={!busy}
                  value={note}
                  multiline
                  onChangeText={setNote}
                />
              ) : null}
              <Button
                label="Submit"
                tone="primary"
                disabled={busy}
                onPress={() => {
                  const missing = firstMissingField(fields, answers);
                  if (missing) setError(`Enter a value for ${missing.label}.`);
                  else
                    void run({
                      status: "submitted",
                      answers,
                      ...(form.allowFreeformNote && note.trim() ? { note } : {}),
                    });
                }}
              />
            </>
          ) : null}
          {local && canAnswer ? (
            <Button
              label="Decline"
              disabled={busy}
              onPress={() =>
                void run({
                  status: "declined",
                  ...(form?.allowFreeformNote && note.trim() ? { note } : {}),
                })
              }
            />
          ) : null}
          {local && canCancel ? (
            <Button label="Cancel request" disabled={busy} onPress={() => void run()} />
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" className="text-danger">
              {error}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}
