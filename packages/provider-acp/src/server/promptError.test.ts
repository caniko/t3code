import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { AcpRequestError, AcpTransportError } from "effect-acp/errors";

import { sendPromptWhenIdle } from "./adapter.ts";
import { isPromptBlockedOnRuntimeRequest } from "./promptError.ts";

it("recognizes a blocked prompt without treating ordinary ACP errors as wedged sessions", () => {
  const blocked =
    "Can't add this prompt to session agy-123: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again";
  assert.isTrue(
    isPromptBlockedOnRuntimeRequest(new AcpRequestError({ code: -32603, errorMessage: blocked })),
  );
  assert.isTrue(
    isPromptBlockedOnRuntimeRequest(
      new AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: { details: blocked },
      }),
    ),
  );
  assert.isTrue(
    isPromptBlockedOnRuntimeRequest(
      new AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: blocked,
      }),
    ),
  );
  assert.isFalse(
    isPromptBlockedOnRuntimeRequest(
      new AcpRequestError({
        code: -32603,
        errorMessage: "Model unavailable",
        data: { details: "upstream timeout" },
      }),
    ),
  );
  assert.isFalse(
    isPromptBlockedOnRuntimeRequest(new AcpTransportError({ detail: blocked, cause: blocked })),
  );
});

it.effect(
  "does not invoke the prompt callback when the turn is already finalized, interrupted, or superseded",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const invoke = () =>
        Effect.sync(() => {
          calls += 1;
          return "sent";
        });

      const finalizedExit = yield* Effect.exit(
        sendPromptWhenIdle({ finalized: true, interrupted: false }, invoke),
      );
      const interruptedExit = yield* Effect.exit(
        sendPromptWhenIdle({ finalized: false, interrupted: true }, invoke),
      );
      const supersededExit = yield* Effect.exit(
        sendPromptWhenIdle({ finalized: false, interrupted: false }, invoke, () => true),
      );

      assert.isTrue(Exit.isFailure(finalizedExit));
      assert.isTrue(Exit.isFailure(interruptedExit));
      assert.isTrue(Exit.isFailure(supersededExit));
      assert.equal(calls, 0);
    }),
);
