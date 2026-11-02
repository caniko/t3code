import { type SessionAccessSnapshot, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { threadAccessRole } from "./sessionAccess.ts";

const threadId = ThreadId.make("thread-1");
const group = (callerRole: "owner" | "viewer" | "participant", threadIds: ThreadId[]) =>
  ({
    id: "g1",
    name: "Group",
    ownerPrincipal: "can",
    createdAt: DateTime.makeUnsafe(0),
    members: [],
    threadIds,
    callerRole,
  }) as unknown as SessionAccessSnapshot["groups"][number];
const snapshot = (
  groups: SessionAccessSnapshot["groups"],
  sharedThreads: SessionAccessSnapshot["sharedThreads"] = [],
): SessionAccessSnapshot => ({ groups, sharedThreads });

describe("threadAccessRole", () => {
  it.each([
    ["the default principal", "owner", undefined, null, "owner"],
    ["the thread owner", "can", "can", null, "owner"],
    ["unknown while loading", "dejana", "can", null, null],
    ["unshared", "dejana", "can", snapshot([]), null],
    [
      "a direct viewer share",
      "dejana",
      "can",
      snapshot([], [{ threadId, role: "viewer" }]),
      "viewer",
    ],
    ["a group viewer", "dejana", "can", snapshot([group("viewer", [threadId])]), "viewer"],
    [
      "the best of a share and a group",
      "dejana",
      "can",
      snapshot([group("participant", [threadId])], [{ threadId, role: "viewer" }]),
      "participant",
    ],
  ] as const)("%s", (_name, principal, ownerPrincipal, snap, expected) => {
    expect(threadAccessRole({ principal, ownerPrincipal, threadId, snapshot: snap })).toBe(
      expected,
    );
  });
});
