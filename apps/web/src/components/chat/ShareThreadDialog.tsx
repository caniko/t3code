import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentQuery } from "~/state/query";
import {
  sessionAccessEnvironment,
  useSessionAccess,
  useSessionAccessMutation,
} from "~/state/sessionAccess";
import { PrincipalRoleForm, ROLE_LABELS } from "../sessionAccess/PrincipalRoleForm";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { shareThreadDialogThreadAtom } from "./shareThreadDialogState";

const NO_GROUP = "none";

export function ShareThreadDialogHost() {
  const threadRef = useAtomValue(shareThreadDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <ShareThreadDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(shareThreadDialogThreadAtom, null)}
    />
  );
}

function ShareThreadDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId } = threadRef;
  const { canMutate, mutate } = useSessionAccessMutation(environmentId);
  const { snapshot } = useSessionAccess(environmentId);
  const shares = useEnvironmentQuery(
    sessionAccessEnvironment.threadShares({ environmentId, input: { threadId } }),
  );
  const ownedGroups = snapshot?.groups.filter((group) => group.callerRole === "owner") ?? [];
  const currentGroup = ownedGroups.find((group) => group.threadIds.includes(threadId));
  const [movingGroup, setMovingGroup] = useState(false);

  const moveToGroup = async (groupId: string) => {
    setMovingGroup(true);
    if (currentGroup !== undefined) {
      const removed = await mutate({
        type: "group.thread.remove",
        groupId: currentGroup.id,
        threadId,
      });
      if (!removed) return setMovingGroup(false);
    }
    const target = ownedGroups.find((group) => group.id === groupId);
    if (target !== undefined) {
      await mutate({ type: "group.thread.add", groupId: target.id, threadId });
    }
    setMovingGroup(false);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share session</DialogTitle>
          <DialogDescription>
            Viewers read this session. Participants can also send messages; their turns run as you.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <PrincipalRoleForm
              submitLabel="Share"
              disabled={!canMutate}
              onSubmit={(principal, role) =>
                mutate({ type: "thread.share", threadId, principal, role })
              }
            />
            {shares.data !== null && shares.data.shares.length > 0 ? (
              <ul aria-label="Shared with" className="divide-y divide-border/60 text-sm">
                {shares.data.shares.map((share) => (
                  <li key={share.principal} className="flex items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate">{share.principal}</span>
                    <span className="text-muted-foreground text-xs">{ROLE_LABELS[share.role]}</span>
                    <Button
                      disabled={!canMutate}
                      size="xs"
                      variant="ghost-muted"
                      aria-label={`Remove ${share.principal}`}
                      onClick={() =>
                        void mutate({
                          type: "thread.unshare",
                          threadId,
                          principal: share.principal,
                        })
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">Not shared with anyone yet.</p>
            )}
            {ownedGroups.length > 0 ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="shrink-0">Session group</span>
                <Select
                  value={currentGroup?.id ?? NO_GROUP}
                  onValueChange={(value) => {
                    if (value !== null && value !== NO_GROUP) void moveToGroup(value);
                  }}
                >
                  <SelectTrigger size="sm" className="w-48" aria-label="Session group">
                    <SelectValue>{currentGroup?.name ?? "None"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {currentGroup === undefined ? (
                      <SelectItem hideIndicator value={NO_GROUP} disabled>
                        None
                      </SelectItem>
                    ) : null}
                    {ownedGroups.map((group) => (
                      <SelectItem hideIndicator key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {currentGroup !== undefined ? (
                  <Button
                    disabled={!canMutate || movingGroup}
                    size="xs"
                    variant="ghost-muted"
                    onClick={() =>
                      void mutate({
                        type: "group.thread.remove",
                        groupId: currentGroup.id,
                        threadId,
                      })
                    }
                  >
                    Remove from group
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
