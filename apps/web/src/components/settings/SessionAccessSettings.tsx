import {
  type EnvironmentId,
  type SessionGroup,
  SessionGroupId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useSessionAccess, useSessionAccessMutation } from "~/state/sessionAccess";
import { PrincipalRoleForm, ROLE_LABELS } from "../sessionAccess/PrincipalRoleForm";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

/** The signed-in principal and its session groups; single-user installs have neither. */
export function SessionAccessSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const { principal, snapshot } = useSessionAccess(environmentId);
  if (environmentId === null || principal === "owner") return null;
  return (
    <>
      <SettingsSection id="account" title="Account">
        <div className="px-3 py-3 text-sm sm:px-4">
          Signed in as <span className="font-medium">{principal}</span>
        </div>
      </SettingsSection>
      <SettingsSection id="session-groups" title="Session groups">
        <div className="space-y-3 px-3 py-3 sm:px-4">
          {snapshot?.groups.map((group) => (
            <SessionGroupRow key={group.id} group={group} environmentId={environmentId} />
          ))}
          {snapshot?.groups.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Group sessions to share them with the same people at once.
            </p>
          ) : null}
          <CreateGroupForm environmentId={environmentId} />
        </div>
      </SettingsSection>
    </>
  );
}

function CreateGroupForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { canMutate, mutate } = useSessionAccessMutation(environmentId);
  const [name, setName] = useState("");
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (name.trim() === "") return;
        const created = await mutate({
          type: "group.create",
          groupId: SessionGroupId.make(randomUUID()),
          name: TrimmedNonEmptyString.make(name.trim()),
        });
        if (created) setName("");
      }}
    >
      <Input
        aria-label="New group name"
        className="flex-1"
        nativeInput
        onChange={(event) => setName(event.currentTarget.value)}
        placeholder="New group name"
        value={name}
      />
      <Button disabled={!canMutate || name.trim() === ""} size="sm" type="submit" variant="outline">
        Create group
      </Button>
    </form>
  );
}

function SessionGroupRow({
  group,
  environmentId,
}: {
  readonly group: SessionGroup;
  readonly environmentId: EnvironmentId;
}) {
  const { canMutate, mutate } = useSessionAccessMutation(environmentId);
  const isOwner = group.callerRole === "owner";
  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{group.name}</span>
        <span className="text-muted-foreground text-xs">
          {isOwner
            ? `${group.threadIds.length} sessions`
            : `${group.ownerPrincipal} · ${ROLE_LABELS[group.callerRole as "viewer" | "participant"]}`}
        </span>
        {isOwner ? (
          <Button
            disabled={!canMutate}
            size="xs"
            variant="ghost-muted"
            onClick={() => void mutate({ type: "group.delete", groupId: group.id })}
          >
            Delete group
          </Button>
        ) : null}
      </div>
      <ul aria-label={`Members of ${group.name}`} className="text-sm">
        {group.members.map((member) => (
          <li key={member.principal} className="flex items-center gap-2 py-1">
            <span className="min-w-0 flex-1 truncate">{member.principal}</span>
            <span className="text-muted-foreground text-xs">{ROLE_LABELS[member.role]}</span>
            {isOwner ? (
              <Button
                disabled={!canMutate}
                size="xs"
                variant="ghost-muted"
                aria-label={`Remove ${member.principal} from ${group.name}`}
                onClick={() =>
                  void mutate({
                    type: "group.member.remove",
                    groupId: group.id,
                    principal: member.principal,
                  })
                }
              >
                Remove
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {isOwner ? (
        <PrincipalRoleForm
          submitLabel="Invite"
          disabled={!canMutate}
          onSubmit={(invitee, role) =>
            mutate({ type: "group.member.invite", groupId: group.id, principal: invitee, role })
          }
        />
      ) : null}
    </div>
  );
}
