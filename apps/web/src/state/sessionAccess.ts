import { useAtomValue } from "@effect/atom-react";
import {
  createSessionAccessEnvironmentAtoms,
  threadAccessRole,
} from "@t3tools/client-runtime/state/sessionAccess";
import {
  DEFAULT_PRINCIPAL_ID,
  type EnvironmentId,
  type ScopedThreadRef,
  type SessionAccessMutation,
  type SessionAccessSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useThreadShell } from "./entities";
import { environmentIdsKey } from "./environmentAtomList";
import { useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";
import { useAtomCommand } from "./use-atom-command";

export const sessionAccessEnvironment = createSessionAccessEnvironmentAtoms(connectionAtomRuntime);

const viewerPrincipalAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentSession.sessionStateValueAtom(environmentId))?.principal ??
      DEFAULT_PRINCIPAL_ID,
  ).pipe(Atom.withLabel(`web-viewer-principal:${environmentId}`)),
);

const EMPTY_PRINCIPAL_ATOM = Atom.make<string>(DEFAULT_PRINCIPAL_ID).pipe(
  Atom.withLabel("web-viewer-principal:empty"),
);

/** The signed-in principal on an environment; the default principal for single-user installs. */
export function useViewerPrincipal(environmentId: EnvironmentId | null): string {
  return useAtomValue(
    environmentId === null ? EMPTY_PRINCIPAL_ATOM : viewerPrincipalAtom(environmentId),
  );
}

/** The session groups and shares of the signed-in principal; nothing is fetched for the default one. */
export function useSessionAccess(environmentId: EnvironmentId | null) {
  const principal = useViewerPrincipal(environmentId);
  const query = useEnvironmentQuery(
    environmentId !== null && principal !== DEFAULT_PRINCIPAL_ID
      ? sessionAccessEnvironment.list({ environmentId, input: {} })
      : null,
  );
  return { principal, snapshot: query.data, refresh: query.refresh };
}

/** What the signed-in principal may do in a thread; `null` when nothing says (the server decides). */
export function useThreadAccessRole(ref: ScopedThreadRef | null) {
  const { principal, snapshot } = useSessionAccess(ref?.environmentId ?? null);
  const shell = useThreadShell(ref);
  return ref === null
    ? null
    : threadAccessRole({
        principal,
        ownerPrincipal: shell?.source.ownerPrincipal,
        threadId: ref.threadId,
        snapshot,
      });
}

const sharedSidebarInputAtom = Atom.family((key: string) => {
  const ids = key === "" ? [] : (key.split("\n") as EnvironmentId[]);
  return Atom.make((get) => {
    const principalByEnvironment = new Map<EnvironmentId, string>();
    const snapshotByEnvironment = new Map<EnvironmentId, SessionAccessSnapshot>();
    for (const environmentId of ids) {
      const principal = get(viewerPrincipalAtom(environmentId));
      if (principal === DEFAULT_PRINCIPAL_ID) continue;
      principalByEnvironment.set(environmentId, principal);
      const snapshot = AsyncResult.getOrElse(
        get(sessionAccessEnvironment.list({ environmentId, input: {} })),
        () => null,
      );
      if (snapshot !== null) snapshotByEnvironment.set(environmentId, snapshot);
    }
    return { principalByEnvironment, snapshotByEnvironment };
  }).pipe(Atom.withLabel(`web-shared-sidebar-input:${key}`));
});

/** Principals and session groups for the environments a sidebar lists. */
export function useSharedSidebarInput(environmentIds: ReadonlyArray<EnvironmentId>) {
  return useAtomValue(sharedSidebarInputAtom(environmentIdsKey(environmentIds)));
}

/** Whether the signed-in principal owns the thread and may share it with other principals. */
export function readCanShareThread(
  ref: ScopedThreadRef,
  ownerPrincipal: string | undefined,
): boolean {
  const principal = appAtomRegistry.get(viewerPrincipalAtom(ref.environmentId));
  return (
    principal !== DEFAULT_PRINCIPAL_ID && principal === (ownerPrincipal ?? DEFAULT_PRINCIPAL_ID)
  );
}

export function useSessionAccessMutation(environmentId: EnvironmentId) {
  const run = useAtomCommand(sessionAccessEnvironment.mutate, { label: "update sharing" });
  const canMutate = useAtomValue(sessionAccessEnvironment.mutate.permissionAtom(environmentId));
  return {
    canMutate,
    mutate: async (mutation: SessionAccessMutation) =>
      (await run({ environmentId, input: mutation }))._tag === "Success",
  };
}
