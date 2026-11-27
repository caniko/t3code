// @effect-diagnostics nodeBuiltinImport:off -- local HTTP listener and private CLI fixture files.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";
import { CliOutput, Command } from "effect/cli";
import { vi } from "vite-plus/test";
import { cli, cliPresenter } from "../binCli.ts";

const token = "operator-request-cli-secret";
const requestDetails = { expiresAt: "2027-01-01T00:00:00Z", metadata: { source: "cli" } };
const createInput = {
  kind: "ops",
  privilege: "user",
  title: "Review",
  summary: "Inspect it.",
  ...requestDetails,
};
const record = {
  ...requestDetails,
  requestId: "req-1",
  threadId: "thread-1",
  kind: "ops",
  privilege: "user",
  title: "Review",
  waitPolicy: { mode: "async" },
  status: "pending",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const run = (args: string[], stdin?: string) =>
  Effect.gen(function* () {
    const result = yield* Command.runWith(cli, { version: "0.0.0" })([
      "operator-request",
      ...args,
    ]).pipe(Effect.scoped, Effect.result);
    return { result, stdout: yield* TestConsole.logLines, stderr: yield* TestConsole.errorLines };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        TestConsole.layer,
        CliOutput.layerPresenter(cliPresenter),
        stdin === undefined
          ? Layer.empty
          : Stdio.layerTest({ stdin: Stream.make(new TextEncoder().encode(stdin)) }),
      ),
    ),
  );

it.live("round-trips all five subcommands over authenticated HTTP with JSON-only stdout", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const authorizations: unknown[] = [];
    const server = NodeHttp.createServer(async (req, res) => {
      authorizations.push(req.headers.authorization);
      if (req.method === "DELETE") {
        res.writeHead(204).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const payload = JSON.parse(body);
      if (payload.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "operator-request-test");
      const reply = (fields: object) =>
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, ...fields }));
      if (payload.method === "initialize") {
        reply({ result: { protocolVersion: "2025-06-18" } });
        return;
      }
      calls.push(payload.params);
      const { name, arguments: args } = payload.params;
      if (args.externalId === "transport-error") {
        reply({ error: { code: -32603, message: `Do not print ${token}` } });
        return;
      }
      const structuredContent =
        name === "t3_operator_request_list"
          ? { requests: [record] }
          : name === "t3_operator_request_resolve"
            ? { ...record, status: "submitted" }
            : name === "t3_operator_request_cancel"
              ? { ...record, status: "cancelled" }
              : record;
      reply({ result: { structuredContent } });
    });
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-operator-request-cli-")),
      ),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        vi.unstubAllEnvs();
        server.close();
      }),
    );
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener.");
    const tokenFile = NodePath.join(directory, "token");
    yield* Effect.promise(() => NodeFSP.writeFile(tokenFile, token, { mode: 0o600 }));
    vi.stubEnv("T3CODE_SERVER_URL", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("T3CODE_AUTH_TOKEN_FILE", tokenFile);
    const resolve = { externalId: "external-1", status: "submitted", decidedVia: "cli" };
    const cancel = { requestId: "req-1", threadId: "thread-1", reason: "Superseded" };
    const path = NodePath.join(directory, "resolve.json");
    yield* Effect.promise(() => NodeFSP.writeFile(path, JSON.stringify(resolve)));
    const cases = [
      { args: ["create", "--json", "-"], stdin: JSON.stringify(createInput), output: record },
      { args: ["create", "--json", JSON.stringify(createInput)], output: record },
      { args: ["status", "--external-id", "external-1"], output: record },
      {
        args: ["list", "--pending", "--thread", "thread-1", "--kind", "ops"],
        output: { requests: [record] },
      },
      { args: ["resolve", "--json", path], output: { ...record, status: "submitted" } },
      {
        args: ["cancel", "--request-id", "req-1", "--thread", "thread-1", "--reason", "Superseded"],
        output: { ...record, status: "cancelled" },
      },
    ];
    for (const { args, stdin, output } of cases) {
      const reply = yield* run(args, stdin);
      expect(reply.result._tag).toBe("Success");
      expect(reply.stderr).toEqual([]);
      expect(reply.stdout.map((line) => JSON.parse(String(line)))).toEqual([output]);
    }
    expect(calls).toEqual(
      [
        ["", createInput],
        ["", createInput],
        ["_status", { externalId: "external-1" }],
        ["_list", { pending: true, threadId: "thread-1", kind: "ops" }],
        ["_resolve", resolve],
        ["_cancel", cancel],
      ].map(([suffix, args]) => ({ name: `t3_operator_request${suffix}`, arguments: args })),
    );
    expect(authorizations.every((header) => header === `Bearer ${token}`)).toBe(true);
    const failure = yield* run(["status", "--external-id", "transport-error"]);
    expect(failure.result._tag).toBe("Failure");
    expect(failure.stdout).toEqual([]);
    expect(failure.stderr.join()).toContain("[redacted]");
    expect(failure.stderr.join()).not.toContain(token);
  }),
);

it.effect.each([
  [["create", "--json", "{"], "Invalid operator request JSON"],
  [["create", "--json", '{"kind":"bad"}'], "Invalid operator request JSON"],
  [["resolve", "--json", '{"requestId":"x","status":"pending"}'], "Invalid operator request JSON"],
  [["status"], "Supply exactly one"],
  [["cancel", "--request-id", "r", "--external-id", "e"], "Supply exactly one"],
  [["list", "--kind", "unknown"], "Invalid operator request options"],
  [["status", "--bogus"], "bogus"],
] as const)("rejects invalid input before transport: %j", ([args, message]) =>
  Effect.gen(function* () {
    const { result, stdout, stderr } = yield* run([...args]);
    expect(result._tag).toBe("Failure");
    expect(stdout).toEqual([]);
    expect(stderr.join()).toContain(message);
  }),
);
