import type { AcpError } from "effect-acp/errors";

const PROMPT_BLOCKED_ON_RUNTIME_REQUEST_MARKER =
  "the running prompt is waiting for a permission or question answer";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isPromptBlockedOnRuntimeRequest(error: AcpError): boolean {
  if (error._tag !== "AcpRequestError") return false;
  const data = record(error.data);
  return [
    error.errorMessage,
    typeof error.data === "string" ? error.data : undefined,
    data?.details,
    data?.detail,
    data?.message,
    data?.error,
  ].some(
    (text) => typeof text === "string" && text.includes(PROMPT_BLOCKED_ON_RUNTIME_REQUEST_MARKER),
  );
}
