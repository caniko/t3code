import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import { readPairingCode } from "./environment.ts";

it.effect("reads a pairing code from stdin without changing literal-code behavior", () =>
  Effect.gen(function* () {
    const input = Stdio.layerTest({
      stdin: Stream.make(new TextEncoder().encode("  pairing-code\n")),
    });
    assert.strictEqual(yield* readPairingCode("-").pipe(Effect.provide(input)), "pairing-code");
    assert.strictEqual(
      yield* readPairingCode("literal-code").pipe(
        Effect.provide(Stdio.layerTest({ stdin: Stream.die("stdin must not be read") })),
      ),
      "literal-code",
    );
    const error = yield* readPairingCode("-").pipe(
      Effect.provide(Stdio.layerTest({ stdin: Stream.empty })),
      Effect.flip,
    );
    assert.strictEqual(error.reason, "pairing_rejected");
    assert.strictEqual(error.message, "The pairing code read from standard input is empty.");
  }),
);
