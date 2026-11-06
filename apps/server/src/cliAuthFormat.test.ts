import { AuthSessionId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { formatIssuedSession } from "./cliAuthFormat.ts";

const issued = {
  sessionId: AuthSessionId.make("session-1"),
  token: "secret-token",
  expiresAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  scopes: ["orchestration:read"] as ReadonlyArray<AuthEnvironmentScope>,
  subject: "mcp-client:can",
};

it("never prints a token that was written to a file", () => {
  const text = formatIssuedSession(issued, { tokenFile: "/run/paperclip-t3-can/token" });

  expect(text).not.toContain("secret-token");
  expect(text).toContain("/run/paperclip-t3-can/token");
});

it("prints the token only when no token file was requested", () => {
  expect(formatIssuedSession(issued)).toContain("secret-token");
  expect(formatIssuedSession(issued, { tokenOnly: true })).toBe("secret-token\n");
});
