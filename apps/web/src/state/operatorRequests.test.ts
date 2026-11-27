import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { operatorRequestEnvironment, pendingOperatorRequestsAtom } from "./operatorRequests";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./environments", () => ({ useEnvironments: vi.fn() }));
vi.mock("./session", () => ({ useEnvironmentsWithScope: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/operator-requests", () => ({
  createOperatorRequestEnvironmentAtoms: () => ({ listPending: vi.fn() }),
}));

it("refreshes mounted server queries for threadless requests and stops after disposal", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const load = vi.fn((_environmentId: EnvironmentId) => AsyncResult.success({ requests: [] }));
  vi.mocked(operatorRequestEnvironment.listPending).mockImplementation(({ environmentId }) =>
    Atom.make(() => load(environmentId)),
  );
  vi.useFakeTimers();
  const registry = AtomRegistry.make();
  try {
    const localPending = pendingOperatorRequestsAtom(local);
    const remotePending = pendingOperatorRequestsAtom(remote);
    registry.mount(localPending);
    registry.mount(remotePending);
    expect(load.mock.calls).toEqual([[local], [remote]]);
    expect(operatorRequestEnvironment.listPending).toHaveBeenCalledWith({
      environmentId: remote,
      input: {},
    });
    vi.advanceTimersByTime(15_000);
    registry.get(localPending);
    registry.get(remotePending);
    expect(load.mock.calls).toEqual([[local], [remote], [local], [remote]]);
    registry.dispose();
    vi.advanceTimersByTime(15_000);
    expect(load).toHaveBeenCalledTimes(4);
  } finally {
    registry.dispose();
    vi.useRealTimers();
  }
});
