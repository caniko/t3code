<!--
Draft reply for https://github.com/pingdotgg/t3code/discussions/12283
(cross-references #27708 and #27974). Not posted. The operator reviews,
edits and posts it themself. Delete this comment block before posting.
-->

Adding a concrete case and a shape that might work for it.

Two of us share each PC at home. Today every machine runs two `t3 serve`
processes, one per OS account, on different ports. That works, but every device
has to pair with two servers per PC, and the ports leak into everything. What we
actually want is one server per machine, where each of us signs in as ourselves
and sees only our own projects and threads. Our provider logins, SSH keys and Git
credentials should stay in our own accounts.

I tried a small version of this in a fork to see how far the existing pieces go.
They go quite far:

- **Identity.** Pairing grants and sessions already carry a `subject`, and a
  session inherits it from its grant. Encoding a person as `principal:<id>` in
  that field (`t3 auth pairing create --principal dejana`) needs no new storage.
  Every existing subject maps to a default `owner`, so single-user installs don't
  change.
- **Ownership.** `thread.create` gets an `ownerPrincipal` stamped server-side, in
  the same spot that already strips a client-supplied `linkOrigin`, and children
  inherit it the same way. Shell, thread, history and dispatch paths all check it
  through one helper. A thread you can't see is "not found".
- **Fail closed.** A principal's session can only call an allowlisted set of RPCs
  and is capped at `orchestration:read`/`operate`. Terminal, filesystem, settings
  and provider scopes would act as the server's OS user, so those stay with the
  owner for now.

That gives separate workspaces, but not isolation. Agents run shell commands, so
whichever OS user runs them can read everything that user can. Real isolation
needs each person's providers, terminals and Git to run as their own OS user. The
cleanest way I found is a small per-user runner: the same binary, started as that
user and reachable only by the server over a Unix socket. A principal's work then
gets a `ChildProcessSpawner` that goes through it. Most process creation already
uses that service. The PTY adapter and the Claude SDK spawn are the exceptions.

Sharing (#27708) fits on top as a later step: share a thread or project with a
group of people as viewer or participant. Turns keep running as the thread owner,
and each message records who sent it, which is what #27974 asks for. I'd want
#26490 fixed first, since anything built on guest-style sharing needs an
allowlisted event projection rather than raw thread events.

Questions for you:

1. Is "principal" bound to the existing pairing `subject` a direction you'd
   accept, or would you rather tie identity to T3 Connect accounts as #27974
   suggests?
2. Would you take identity plus workspace filtering on its own, with execution
   isolation as a separate step? Or is it only worth doing with the runner?
3. If this is something you'd consider, which piece should come first as its own
   PR?

The design notes and prototype are in
https://github.com/caniko/t3code/tree/feat/multi-user-principals
(`docs/internals/multi-user.md`). I'm not opening a PR without your go-ahead.
