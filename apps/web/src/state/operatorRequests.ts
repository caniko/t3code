import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { createOperatorRequestEnvironmentAtoms } from "@t3tools/client-runtime/state/operator-requests";
import {
  AuthAccessReadScope,
  type EnvironmentId,
  type OperatorRequestRecord,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { useEnvironments } from "./environments";
import { useEnvironmentsWithScope } from "./session";

export const operatorRequestEnvironment =
  createOperatorRequestEnvironmentAtoms(connectionAtomRuntime);

export const pendingOperatorRequestsAtom = Atom.family((environmentId: EnvironmentId) => {
  const query = operatorRequestEnvironment.listPending({ environmentId, input: {} });
  return Atom.make((get) => {
    const result = get(query);
    if (!result.waiting) {
      // Thread streams cannot report requests that aren't attached to a thread.
      const timer = setTimeout(() => get.refresh(query), 15_000);
      get.addFinalizer(() => clearTimeout(timer));
    }
    return { environmentId, result };
  }).pipe(Atom.withLabel(`web-operator-requests:${environmentId}`));
});

const pendingByEnvironment = environmentAtomList(
  "web-operator-requests:pending",
  pendingOperatorRequestsAtom,
);

export interface PendingOperatorRequest {
  readonly environmentId: EnvironmentId;
  readonly request: OperatorRequestRecord;
}

const pendingEntries = Atom.family((key: string) =>
  Atom.map(pendingByEnvironment(key), (environments) =>
    environments
      .flatMap(({ environmentId, result }) =>
        AsyncResult.getOrElse(result, () => ({ requests: [] })).requests.map(
          (request): PendingOperatorRequest => ({ environmentId, request }),
        ),
      )
      .sort((a, b) => b.request.updatedAt.localeCompare(a.request.updatedAt)),
  ),
);

function useReadableEnvironmentKey() {
  const { environments } = useEnvironments();
  const connected = environments.filter(({ connection }) => connection.phase === "connected");
  const readable = useEnvironmentsWithScope(connected, AuthAccessReadScope);
  return environmentIdsKey(
    connected
      .filter(({ environmentId }) => readable.has(environmentId))
      .map(({ environmentId }) => environmentId),
  );
}

export function usePendingOperatorRequestCount() {
  const key = useReadableEnvironmentKey();
  return useAtomValue(pendingEntries(key), (entries) => entries.length);
}

export function usePendingOperatorRequests() {
  const key = useReadableEnvironmentKey();
  const environments = useAtomValue(pendingByEnvironment(key));
  const entries = useAtomValue(pendingEntries(key));
  const registry = useContext(RegistryContext);
  return {
    entries,
    isPending: environments.some(({ result }) => result.waiting),
    hasError: environments.some(({ result }) => result._tag === "Failure"),
    refresh: () => {
      for (const { environmentId } of environments) {
        registry.refresh(operatorRequestEnvironment.listPending({ environmentId, input: {} }));
      }
    },
  };
}
