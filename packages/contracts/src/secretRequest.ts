import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import { SecretReference } from "./secretReference.ts";

/** The http(s) page a secret card may open, or null for anything else. */
export function secretRequestPageUrl(value: string): URL | null {
  // React Native's URL has no `canParse`.
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host !== "" ? url : null;
  } catch {
    return null;
  }
}

const AgenixName = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

/** Where `delivery: "agenix"` stores a value; becomes the store command's flags. */
export const SecretAgenixTarget = Schema.Struct({
  user: Schema.optional(AgenixName),
  rootModule: Schema.optional(AgenixName),
  host: Schema.optional(AgenixName),
  name: AgenixName,
  /** Environment variables the secret is wired to; leave out for a bare secret. */
  env: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))).check(
      Schema.isMinLength(1),
    ),
  ),
  category: Schema.optional(AgenixName),
  expires: Schema.optional(Schema.String.check(Schema.isPattern(/^(?:\d{4}-\d{2}-\d{2}|never)$/))),
  custodian: Schema.optional(AgenixName),
  project: Schema.optional(AgenixName),
  /** Called with the value as a Bearer token before it is stored; pass/fail only. */
  verifyUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isPattern(/^https:\/\//))),
}).check(
  Schema.makeFilter(
    (target) =>
      [target.user, target.rootModule, target.host].filter((owner) => owner !== undefined)
        .length === 1,
    { expected: "exactly one of user, rootModule or host" },
  ),
);
export type SecretAgenixTarget = typeof SecretAgenixTarget.Type;

/** The store command's result: metadata only, never the value. */
export const SecretAgenixResult = Schema.Struct({
  path: Schema.String,
  committed_sha: Schema.String,
  verify: Schema.String,
  rekey: Schema.String,
  rops_id: Schema.optional(Schema.String),
});
export type SecretAgenixResult = typeof SecretAgenixResult.Type;

/** Server stores the value under a one-use SecretRef; the thread learns only status. */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("save"), secret: TrimmedNonEmptyString }),
    /** A request with `fields`: one value per field name. */
    Schema.Struct({
      type: Schema.Literal("save"),
      values: Schema.Record(Schema.String, TrimmedNonEmptyString),
    }),
    Schema.Struct({ type: Schema.Literal("decline") }),
    /** Read once through a configured secret provider; only servers advertising `secretRequestReferences` accept it. */
    Schema.Struct({ type: Schema.Literal("reference"), reference: SecretReference }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

/** What the agent reads when its card ends without a secret. */
export const SECRET_REQUEST_UNSAVED_NOTE = {
  declined:
    "The user declined. Don't ask for it in chat or another way; say what's blocked and go on without it.",
  cancelled:
    "The card closed with the run. Ask again with a new clientRequestId only if the secret is still needed.",
  timed_out:
    "No answer in time. Don't ask in chat; ask again with a new clientRequestId only if it is still needed.",
} as const;

const SECRET_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the secret request.",
  not_found: "This secret request no longer exists.",
  already_answered: "This secret request was already answered.",
  fields_mismatch: "This request asks for different values. Update the app and try again.",
  agent_stopped: "The agent that asked has stopped, so this secret can't be used.",
  store_failed: "Could not store the secret.",
  reference_unreadable: "Could not read the secret from the secret provider.",
  record_failed: "Saved the secret, but could not update the request.",
  invalid_ref: "That secretRef is not valid.",
  read_failed: "Could not read the secret.",
  ref_unavailable:
    "That secretRef was already used or does not exist. Ask the user again with request_secret.",
  ref_expired: "That secretRef expired. Ask the user again with request_secret.",
  consume_failed: "Could not use that secretRef. Try again.",
  not_a_file_request:
    'The user did not save this secret for shell use. Ask again with request_secret and delivery: "file".',
  agenix_not_configured:
    'This T3 server has no agenix store command (setting "agenixSecretCommand"). Ask with another delivery.',
  agenix_failed: "Could not store the secret in agenix.",
} as const;

export const SecretRequestFailureReason = Schema.Literals(
  Object.keys(SECRET_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof SECRET_REQUEST_FAILURE_MESSAGES
  >,
);
export type SecretRequestFailureReason = typeof SecretRequestFailureReason.Type;

export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  {
    reason: SecretRequestFailureReason,
    /** The secret provider a `reference_unreadable` answer named. */
    provider: Schema.optionalKey(Schema.String),
    /** Shown after the message; never holds the value. */
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "reference_unreadable" && this.provider !== undefined) {
      return `Could not read the secret from the secret provider "${this.provider}". Unlock it and try again, or enter the value.`;
    }
    const message = SECRET_REQUEST_FAILURE_MESSAGES[this.reason];
    return this.detail === undefined ? message : `${message} ${this.detail}`;
  }
}
