import { EnvironmentId, type SessionAccessSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { partitionSharedThreads } from "./sidebarProjectGrouping";

const env = EnvironmentId.make("env-1");
const thread = (id: string, ownerPrincipal?: string) => ({
  environmentId: env,
  id,
  source: { ownerPrincipal },
});
const snapshot = {
  groups: [{ name: "Lab", threadIds: ["t3"] }],
  sharedThreads: [],
} as unknown as SessionAccessSnapshot;

describe("partitionSharedThreads", () => {
  const threads = [thread("t1", "dejana"), thread("t2", "can"), thread("t3", "can"), thread("t4")];

  it("leaves a default-principal session untouched", () => {
    const result = partitionSharedThreads({
      threads,
      principalByEnvironment: new Map(),
      snapshotByEnvironment: new Map(),
    });
    expect(result).toEqual({ mine: threads, shared: [] });
  });

  it("splits a signed-in session by owner, then session group", () => {
    const result = partitionSharedThreads({
      threads,
      principalByEnvironment: new Map([[env, "dejana"]]),
      snapshotByEnvironment: new Map([[env, snapshot]]),
    });
    expect(result.mine.map((t) => t.id)).toEqual(["t1"]);
    expect(
      result.shared.map((section) => [
        section.ownerPrincipal,
        section.groups.map((g) => [g.groupName, g.threads.map((t) => t.id)]),
      ]),
    ).toEqual([
      [
        "can",
        [
          ["Lab", ["t3"]],
          [null, ["t2"]],
        ],
      ],
      ["owner", [[null, ["t4"]]]],
    ]);
  });
});
