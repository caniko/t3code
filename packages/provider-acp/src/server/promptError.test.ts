import { assert, it } from "@effect/vitest";
import { AcpRequestError, AcpTransportError } from "effect-acp/errors";

import { isPromptBlockedOnRuntimeRequest } from "./promptError.ts";

it("recognizes a blocked prompt without treating ordinary ACP errors as wedged sessions", () => {
  const blocked =
    "Can't add this prompt to session agy-123: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again";
  assert.isTrue(
    isPromptBlockedOnRuntimeRequest(new AcpRequestError({ code: -32603, errorMessage: blocked })),
  );
  assert.isFalse(
    isPromptBlockedOnRuntimeRequest(
      new AcpRequestError({ code: -32603, errorMessage: "Model unavailable" }),
    ),
  );
  assert.isFalse(
    isPromptBlockedOnRuntimeRequest(new AcpTransportError({ detail: blocked, cause: blocked })),
  );
});
