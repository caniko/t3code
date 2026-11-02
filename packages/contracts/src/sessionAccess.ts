import * as Schema from "effect/Schema";

import { PrincipalId } from "./auth.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** What a principal other than the owner may do in a session: read it, or also send and steer. */
export const SessionRole = Schema.Literals(["viewer", "participant"]);
export type SessionRole = typeof SessionRole.Type;

export const SessionGroupId = TrimmedNonEmptyString.pipe(Schema.brand("SessionGroupId"));
export type SessionGroupId = typeof SessionGroupId.Type;

export const SessionGroupMember = Schema.Struct({ principal: PrincipalId, role: SessionRole });
export type SessionGroupMember = typeof SessionGroupMember.Type;

export const SessionGroup = Schema.Struct({
  id: SessionGroupId,
  name: TrimmedNonEmptyString,
  ownerPrincipal: PrincipalId,
  createdAt: Schema.DateTimeUtc,
  members: Schema.Array(SessionGroupMember),
  threadIds: Schema.Array(ThreadId),
  /** The caller's relation to the group: `owner`, or its role as a member. */
  callerRole: Schema.Literals(["owner", ...SessionRole.literals]),
});
export type SessionGroup = typeof SessionGroup.Type;

export const SessionThreadShare = Schema.Struct({ principal: PrincipalId, role: SessionRole });
export type SessionThreadShare = typeof SessionThreadShare.Type;

export const SessionAccessSnapshot = Schema.Struct({
  /** Groups the caller owns or belongs to. */
  groups: Schema.Array(SessionGroup),
  /** Threads shared directly with the caller. */
  sharedThreads: Schema.Array(Schema.Struct({ threadId: ThreadId, role: SessionRole })),
});
export type SessionAccessSnapshot = typeof SessionAccessSnapshot.Type;

export const SessionAccessThreadSharesInput = Schema.Struct({ threadId: ThreadId });
export type SessionAccessThreadSharesInput = typeof SessionAccessThreadSharesInput.Type;

export const SessionAccessMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("group.create"),
    groupId: SessionGroupId,
    name: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("group.rename"),
    groupId: SessionGroupId,
    name: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("group.delete"), groupId: SessionGroupId }),
  Schema.Struct({
    type: Schema.Literal("group.thread.add"),
    groupId: SessionGroupId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("group.thread.remove"),
    groupId: SessionGroupId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("group.member.invite"),
    groupId: SessionGroupId,
    principal: PrincipalId,
    role: SessionRole,
  }),
  Schema.Struct({
    type: Schema.Literal("group.member.remove"),
    groupId: SessionGroupId,
    principal: PrincipalId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.share"),
    threadId: ThreadId,
    principal: PrincipalId,
    role: SessionRole,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.unshare"),
    threadId: ThreadId,
    principal: PrincipalId,
  }),
]);
export type SessionAccessMutation = typeof SessionAccessMutation.Type;

/** Another principal's group or thread fails as `not_found`, so its existence is not revealed. */
export class SessionAccessError extends Schema.TaggedError<SessionAccessError>()(
  "SessionAccessError",
  {
    reason: Schema.Literals(["not_found", "forbidden", "conflict", "invalid", "storage"]),
    message: Schema.String,
  },
) {}
