import {
  DEFAULT_PRINCIPAL_ID,
  type OrchestrationV2Command,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";

export type ThreadAction = "read" | "write";

/**
 * The one rule for who may touch a thread: its owner, or the default principal that administers
 * the environment. Members and shares extend this function and `threadOwnerScope` together.
 */
export const canAccessThread = (
  principal: string,
  thread: { readonly ownerPrincipal?: string | undefined },
  _action: ThreadAction,
) =>
  principal === DEFAULT_PRINCIPAL_ID ||
  (thread.ownerPrincipal ?? DEFAULT_PRINCIPAL_ID) === principal;

/** The owner a SQL query filters on to match `canAccessThread`; undefined means no filter. */
export const threadOwnerScope = (principal: string) =>
  principal === DEFAULT_PRINCIPAL_ID ? undefined : principal;

const visibleThreads = (principal: string, threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
  threads.filter((thread) => canAccessThread(principal, thread, "read"));

/** Project and thread-removal items carry no thread content, so they pass through. */
export const scopeShellStreamItem = (
  principal: string,
  item: OrchestrationV2ShellStreamItem,
): OrchestrationV2ShellStreamItem | null => {
  switch (item.kind) {
    case "snapshot":
      return {
        ...item,
        snapshot: {
          ...item.snapshot,
          threads: visibleThreads(principal, item.snapshot.threads),
          archivedThreads: visibleThreads(principal, item.snapshot.archivedThreads),
        },
      };
    case "thread.updated":
      return canAccessThread(principal, item.thread, "read") ? item : null;
    default:
      return item;
  }
};

export const scopeThreadList = visibleThreads;

/** Threads a command reads or changes that must already exist; null when a command that is not `thread.create` names none. */
export const existingThreadIdsOfCommand = (
  command: OrchestrationV2Command,
): ReadonlyArray<ThreadId> | null => {
  if (command.type === "thread.create") return [];
  if (command.type === "thread.fork") return [command.sourceThreadId];
  const named: ReadonlyArray<unknown> = [
    "threadId" in command ? command.threadId : undefined,
    "parentThreadId" in command ? command.parentThreadId : undefined,
    "targetThreadId" in command ? command.targetThreadId : undefined,
    "sourceThreadId" in command ? command.sourceThreadId : undefined,
    "senderThreadId" in command ? command.senderThreadId : undefined,
    "sourcePlanRef" in command ? command.sourcePlanRef?.threadId : undefined,
  ];
  const ids = [...new Set(named.filter((id): id is ThreadId => typeof id === "string"))];
  return ids.length === 0 ? null : ids;
};
