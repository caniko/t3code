import {
  type EnvironmentId,
  type OperatorRequestListPendingInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { requestGuarded } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "./runtime.ts";

export function createOperatorRequestEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const revision = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const listPending = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:operator-requests:list-pending",
    execute: (input: OperatorRequestListPendingInput) =>
      requestGuarded(WS_METHODS.operatorRequestsListPending, input),
    refreshTrigger: ({ environmentId }) => revision(environmentId),
  });
  const onSuccess = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      const atom = revision(environmentId);
      registry.set(atom, registry.get(atom) + 1);
    });
  return {
    listPending,
    answer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:operator-requests:answer",
      tag: WS_METHODS.operatorRequestsAnswer,
      onSuccess,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:operator-requests:cancel",
      tag: WS_METHODS.operatorRequestsCancel,
      onSuccess,
    }),
    launchDesktop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:operator-requests:launch-desktop",
      tag: WS_METHODS.operatorRequestsLaunchDesktop,
    }),
  };
}
