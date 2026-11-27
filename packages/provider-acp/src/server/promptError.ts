import type { AcpError } from "effect-acp/errors";

export function isPromptBlockedOnRuntimeRequest(error: AcpError): boolean {
  return (
    error._tag === "AcpRequestError" &&
    error.errorMessage.includes("the running prompt is waiting for a permission or question answer")
  );
}
