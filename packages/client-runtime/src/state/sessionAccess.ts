import {
  DEFAULT_PRINCIPAL_ID,
  type SessionAccessSnapshot,
  type SessionRole,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createSessionAccessEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:session-access:list",
    tag: WS_METHODS.sessionAccessList,
    staleTimeMs: 10_000,
    // The shell stream does not announce a newly shared thread, so recipients poll for it.
    refreshIntervalMs: 30_000,
  });
  const threadShares = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:session-access:thread-shares",
    tag: WS_METHODS.sessionAccessThreadShares,
  });
  return {
    list,
    threadShares,
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:session-access:mutate",
      tag: WS_METHODS.sessionAccessMutate,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(list({ environmentId, input: {} }));
          if ("threadId" in input) {
            registry.refresh(threadShares({ environmentId, input: { threadId: input.threadId } }));
          }
        }),
    }),
  };
}

/**
 * What `principal` may do in a thread: its owner (the default principal reaches every
 * thread), or the best role a share or group gives it. `null` while the snapshot is unknown.
 */
export function threadAccessRole(input: {
  readonly principal: string;
  readonly ownerPrincipal: string | undefined;
  readonly threadId: ThreadId;
  readonly snapshot: SessionAccessSnapshot | null;
}): "owner" | SessionRole | null {
  if (
    input.principal === DEFAULT_PRINCIPAL_ID ||
    input.principal === (input.ownerPrincipal ?? DEFAULT_PRINCIPAL_ID)
  ) {
    return "owner";
  }
  if (input.snapshot === null) return null;
  const roles: SessionRole[] = [
    ...input.snapshot.sharedThreads.flatMap((share) =>
      share.threadId === input.threadId ? [share.role] : [],
    ),
    ...input.snapshot.groups.flatMap((group) =>
      group.threadIds.includes(input.threadId)
        ? [group.callerRole === "owner" ? ("participant" as const) : group.callerRole]
        : [],
    ),
  ];
  return roles.includes("participant") ? "participant" : (roles[0] ?? null);
}
