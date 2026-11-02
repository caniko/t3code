# Multi-user environments (fork design)

Status: fork-only design for caniko/t3code. Upstream has not approved this
direction; the related Ideas discussions are #12283 (multi-user self-hosting
with isolated execution), #27974 (each person signs in as themselves), #27708
(share threads with a team) and #24944 (collaboration in the app).

## Goal

Several people use one T3 Code server on one machine. Each person has their own
workspace: their projects and threads, their provider logins, their Git and SSH
credentials. The machine runs one server on one port and is paired once per
device, so nobody needs a URL or port of their own. Later, people can share a
thread or project with a group and work on it together.

The first deployment is a household: `can` and `dejana` each have an OS account
on every PC (atlas, murph, nomad, starlord). Today each PC runs one `t3 serve`
per person on separate ports. This design replaces that pair with one server per
PC. There is no central hub server: a public ingress only proxies to these
per-PC servers.

Phases:

- **C1a, principals and workspaces.** Identity, ownership and filtering. A
  prototype is on `feat/multi-user-principals`.
- **C1b, per-principal execution.** Providers, terminals and Git run as the
  principal's own OS user.
- **C2, groups and collaboration.** Outline only.
- **Later, separately:** launching a thread on a linked environment from the UI.
  It is not part of C1.

## Principals

A principal is a person known to the environment. Its id is a short slug
(`[a-z0-9][a-z0-9-]{0,31}`).

**Binding.** Pairing grants and sessions already carry a `subject`, and a
session inherits its grant's subject when it is exchanged. A principal is
encoded in that same field as `principal:<id>`, so issuance, replacement,
revocation and listing need no new storage. `principalOfSubject` maps every
other subject (`browser`, `one-time-token`, `desktop-bootstrap`, `mcp-client`,
…) to the default principal `owner`. A malformed `principal:` value maps to
itself, never to `owner`, so a bad id cannot widen access.

**Issuance.** `t3 auth pairing create --principal dejana` and
`t3 auth session issue --principal dejana` mint credentials for a principal.
Only a session that holds `access:write` can create them, as today.

**Default principal.** `owner` administers the environment: settings, provider
instances, links, access management, maintenance. Every existing install has
exactly one principal, `owner`, so nothing changes for a single user.

**MCP approval codes.** A principal's pairing code is refused as an MCP approval
code. MCP client sessions use the fixed `mcp-client` subject, so accepting the
code would mint a session that acts as `owner`.

## Workspaces (C1a)

**Ownership is stamped, never claimed.** `thread.create` gets `ownerPrincipal`
from the calling session in the same place the server strips a client-supplied
`linkOrigin` (`withCreationProvenance`). For `owner` the field is omitted, so
existing threads and new single-user threads stay byte-identical. Like
`linkOrigin`, the field lives in the thread payload, needs no migration, and
passes to subagents, forks and delegated children.

**One visibility rule.** A thread is visible to principal P when
`(thread.ownerPrincipal ?? "owner") === P`
([ThreadOwnership.ts](../../apps/server/src/orchestration-v2/ThreadOwnership.ts)).
Every read and write that names a thread goes through that helper:

- the shell snapshot and live shell items (other principals' `thread.updated`
  items are dropped);
- thread subscriptions, projections, turn items, and the archived and
  older-settled pages;
- the HTTP thread snapshot, transcript and history routes;
- `dispatchCommand` for every thread the command names.

A thread another principal cannot see fails as not found, so its existence is
not revealed. [`canAccessThread`](../../apps/server/src/orchestration-v2/ThreadOwnership.ts)
is the one rule, asked with `read` or `write` (dispatch, launch into an
existing thread, stop, and MCP writes need `write`). Today it admits the owner
and the default `owner` principal, which administers the environment and sees
every thread; sharing extends this function and `threadOwnerScope`, its SQL
counterpart, and nothing else.

**Server administration.** A principal's scopes (`AuthPrincipalScopes`) cover
working in the app: threads, projects, terminals, files, source control,
previews and provider management. They omit settings, environment maintenance,
diagnostics, relay and access scopes, so server-wide administration is refused by
the scope check on RPC and HTTP alike. `PRINCIPAL_DENIED_RPC_METHODS` in
[RpcAuthorization.ts](../../apps/server/src/auth/RpcAuthorization.ts) lists the
few methods under scopes a principal holds that still read server-wide state or
the server account's own agent sessions. A new server-wide method under such a
scope must be added there. Terminals, files, previews and provider credentials
are not owner-filtered and run as the server's OS user until per-principal
execution lands.

**Projects.** Projects need the same treatment: a nullable `owner_principal`
column on `projection_projects` (migration `077`), stamping on `project.create`,
shell filtering, and ownership checks on `projects.mutate`. Two people may
register the same repository; each gets their own project record, so the
repository identity groups them and nothing more.

## Per-principal execution (C1b)

Agents run arbitrary commands. Whatever OS user runs a principal's provider
process can read everything that user can read. Workspace filtering alone keeps
honest clients apart, but it does not keep one principal's agents out of the
other principal's provider tokens, SSH keys or checkouts. Two ways to place
execution:

**A. One OS user, a HOME per principal.** The server spawns each principal's
providers, terminals and Git with `HOME`, `XDG_*`, `CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, `GIT_CONFIG_GLOBAL` and `SSH_AUTH_SOCK` pointing into
`<T3 home>/principals/<id>/`.

- Small change: environment variables at the spawn sites. Nothing privileged.
- Logins and caches stay apart in practice.
- Not a boundary. Any agent with a shell, which includes every approval-required
  or full-access agent, can read the other principal's HOME, because both run as
  the same user. Repositories must also live somewhere both can write.
- Fits people who already share a machine account and trust each other, which is
  the #27974 trust model.

**B. A separate OS user per principal (recommended).** The server runs as an
unprivileged service user. Each principal maps to an OS account, for example
`dejana → dejana`. Everything the server starts on a principal's behalf runs as
that account, through a per-principal runner:

- The runner is `t3 runner`: the same binary, started as the principal's own
  user. On Linux that is a system unit `t3-runner@<user>.service` with
  `User=<user>` and a socket in `/run/t3/runner/<user>.sock`, mode 0660 and
  group `t3`, so only the server can reach it. It spawns processes, holds their
  stdio and PTYs, and forwards signals and resizes.
- On the server side, a principal's work gets a per-principal
  `ChildProcessSpawner` layer that sends spawns to its runner. Most process
  creation already goes through that service, so this is one seam. The
  exceptions are the PTY adapter (`terminal/NodePtyAdapter.ts`) and the Claude
  SDK spawn in `ClaudeAdapterV2.ts`, which need their own runner path.
- Provider CLIs, Git, worktrees, checkpoints and project setup scripts then run
  as the principal. Logins, SSH agents and Git credentials stay in that user's
  HOME, and the kernel keeps principals apart even from a full-access agent.
- The server still reads workspace files in-process for previews, diffs and
  assets. Either give it group read access to the principal's project roots,
  which is simple and treats the server as a trusted control plane, or send
  those reads through the runner too. Start with group read.
- With a runner in place, the C1a scope ceiling can relax: a principal's
  terminal and provider-login RPCs become safe once they run in that principal's
  runner.
- Costs: a spawn protocol (stdio streaming, PTY, signals, exit status), one
  extra hop per process, per-OS packaging (systemd on Linux; launchd and Windows
  services are open questions), and installation needs root once to create the
  units.

Why B over the alternatives:

- **CAP_SETUID in the server** would drop privileges per spawn. Node supports
  `uid`/`gid` in `child_process`, but Effect's `ChildProcess` options do not.
  More importantly, a compromised server could become any user, root included.
  The runner design keeps the server unprivileged and limits it to the runners
  that exist.
- **A front router to one stock server per person** (today's layout behind one
  URL) isolates execution without touching the spawn paths. But the router would
  have to impersonate one environment while relaying several, each with its own
  environment id, event sequence and pairing state. That costs more and breaks
  the identity rules in [remote.md](./remote.md).

A single-user install keeps today's behavior. With no principal map configured,
`owner` runs in-process as the server user and no runner exists.

## Settings and providers

Server settings and provider instances stay environment-wide and owned by
`owner`. Each principal's provider availability comes from what its runner
reports: the CLIs that are installed and logged in for that OS user. Model
defaults and keybindings become per-principal preferences.
`subscribeServerConfig` would then return the caller's view. Until that exists,
principals see the environment's provider list. That leaks configuration, not
content.

## Peer links

Linked environments stay environment-to-environment. A link that one principal
creates belongs to that principal: the link record gains `ownerPrincipal`, and
`PeerForwarding.resolve` refuses callers whose thread has a different owner.
Each principal's agents therefore reach only that principal's links. On the
receiving side, a link pairs with a principal's code and gets that principal's
session, so its work lands in the right workspace. That requires `mcp-client`
sessions to carry a principal, a deliberate change to the MCP approval refusal
above. Launching a thread on a linked environment from the UI, without an agent
in between, is a separate later item.

## MCP and agents

Agent tools resolve the calling thread (`McpInvocationContext`). The caller's
principal is that thread's `ownerPrincipal`; an outside MCP client acts as
`owner`. Unlike client point reads, `owner` gets no exemption here, because its
agents must not read a principal's threads either. Direct thread reads and
writes, and thread listings, go through the same visibility helper in
[threadAccess.ts](../../apps/server/src/mcp/threadAccess.ts), and listings filter
before they paginate. Thread mentions in a message's context and
`delegate_task` targets in another project still need the same check.

## Migration

- **Existing state.** Rows without an owner belong to `owner`. No data
  migration.
- **Merging a second person's server** (today's per-user ports). A one-time
  `t3 principal import --from <their T3 home> --as dejana` copies their projects
  and threads into this database with `ownerPrincipal` set, then their old
  server retires. Until it exists, a principal starts with an empty workspace
  and old threads stay readable on the old server.
- **Clients.** Each device pairs once per principal with a principal pairing
  link. A browser profile holds one principal per environment; switching
  principals means another profile or device for now.

## Threat model

Trusted:

- `owner`;
- the server process;
- in model A, every principal.

Defended against, under model B:

- a principal, or that principal's agents, reading or changing another
  principal's threads, projects, provider logins or files;
- a principal escalating to environment administration.

Not defended against:

- `owner`, who can mint any principal's credential;
- root on the machine;
- denial of service between principals on shared CPU and memory;
- side channels such as timing and shell counts. Older-settled counts are still
  per project.

Known gaps in the prototype:

- **Thread mentions** in message context are not checked yet (see above).
- **Project records** are not principal-filtered until migration 077 lands.
  Their names and paths are visible to every principal.
- **Provider-native subagent threads** created from adapter paths that do not
  inherit from the parent thread get no owner. They default to `owner` and are
  hidden from the principal who started the parent.
- **Removal events** pass through: `thread.removed` reveals a thread id, and
  nothing else, to every principal.

Prerequisite for C2:

- **#26490** (guest share stream ships raw owner thread events past the filtered
  guest view) must be fixed before anything builds on guest shares. The same
  rule applies here: a group viewer must get a projection built from an
  allowlist of event types, never raw thread events.

## C2: groups and collaboration (outline)

- **Groups.** A group is a named set of principals that `owner` manages. Each
  group membership is a role: `viewer` reads, and `participant` can send
  messages, answer approvals and steer turns.
- **Sharing.** A thread or project can be shared with a group. A project share
  covers threads created in it after the share, not older private ones. The
  share lives in the thread or project projection, like a guest share today.
  Replacing, closing or archiving a share revokes it at once. The visibility
  helper becomes "owner, or a member of a group the thread is shared with".
- **Execution stays with the owner.** Turns in a shared thread run in the
  thread owner's runner, with the owner's provider login. A participant's
  message is attributed to them (#27974: record the sender on each message),
  and the agent sees who is speaking. Participants never get a session as the
  owner, and never reach the owner's terminal or files except through the
  thread's normal UI.
- **Fences.** Work a participant starts in a shared thread carries a
  `collabOrigin` modelled on `linkOrigin`, so `assertSameLink`-style rules keep
  it from changing the owner's other threads, projects or settings.
- **Guests stay separate.** Guest links remain the anonymous, single-thread,
  read-and-propose path. Groups are the authenticated path for known
  principals. Both must use the allowlisted projection required by #26490.
- **Presence and chat** (#24944) are UI on top of shares and stay out of the
  first C2 step.
