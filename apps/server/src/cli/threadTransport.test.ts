// @effect-diagnostics nodeBuiltinImport:off - a fake MCP endpoint and protected token files are the boundary under test.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/cli";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  THREAD_AUTH_TOKEN_FILE_ENV,
  THREAD_SERVER_URL_ENV,
  redactCredentials,
  resolveThreadTransport,
} from "./threadTransport.ts";
import { withThreadTools } from "./thread.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const withTempDir = <A, E, R>(run: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-thread-transport-"))),
    run,
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  ).pipe(Effect.provide(layerCliRuntime));

const writeTokenFile = (dir: string, token: string) => {
  const file = NodePath.join(dir, "token");
  NodeFS.writeFileSync(file, token, { mode: 0o600 });
  NodeFS.chmodSync(file, 0o600);
  return file;
};

const withEnv = <A, E, R>(
  values: Readonly<Record<string, string | undefined>>,
  run: () => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return saved;
    }),
    run,
    (saved) =>
      Effect.sync(() => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

const withMcpServer = <A, E, R>(
  run: (origin: string, requests: Array<CapturedRequest>) => Effect.Effect<A, E, R>,
  options?: { readonly toolErrorMessage?: string },
) => {
  const requests: Array<CapturedRequest> = [];
  return Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          requests.push({
            method: request.method ?? "",
            url: request.url ?? "",
            authorization: request.headers.authorization,
            body,
          });
          response.setHeader("content-type", "application/json");
          if (request.method === "DELETE") {
            response.writeHead(200);
            response.end();
            return;
          }
          const message = JSON.parse(body) as { readonly id?: unknown; readonly method?: string };
          if (message.method === "initialize") {
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  serverInfo: { name: "test", version: "0.0.0" },
                },
              }),
            );
            return;
          }
          if (message.method === "notifications/initialized") {
            response.writeHead(202);
            response.end();
            return;
          }
          if (message.method === "tools/call" && options?.toolErrorMessage !== undefined) {
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32000, message: options.toolErrorMessage },
              }),
            );
            return;
          }
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { structuredContent: { projects: [], nextCursor: null }, content: [] },
            }),
          );
        });
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die(new Error("Expected a TCP address"));
      }
      const origin = `http://127.0.0.1:${String(address.port)}`;
      return run(origin, requests).pipe(Effect.ensuring(Effect.sync(() => server.close())));
    },
    (server) => Effect.sync(() => server.close()),
  );
};

it.effect("keeps the local transport when neither variable is set", () =>
  Effect.gen(function* () {
    expect(yield* resolveThreadTransport({})).toEqual({ kind: "local" });
  }).pipe(Effect.provide(layerCliRuntime)),
);

it("redacts a bearer token from error text", () => {
  const token = "eyJhbGciOi.test-token-value";

  expect(redactCredentials(`request failed: Authorization: Bearer ${token}`, token)).not.toContain(
    token,
  );
  expect(redactCredentials(`request failed: Authorization: Bearer ${token}`, token)).toContain(
    "[redacted]",
  );
  expect(redactCredentials("Bearer another-token", "")).not.toContain("another-token");
});

it.effect("reads the remote origin and bearer token from the environment", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const tokenFile = writeTokenFile(dir, "secret-token");

      const transport = yield* resolveThreadTransport({
        [THREAD_SERVER_URL_ENV]: "http://127.0.0.1:3773/",
        [THREAD_AUTH_TOKEN_FILE_ENV]: tokenFile,
      });

      expect(transport).toEqual({
        kind: "remote",
        origin: "http://127.0.0.1:3773",
        authorization: "Bearer secret-token",
      });
    }),
  ),
);

it.effect("names both variables when only one is set", () =>
  Effect.gen(function* () {
    const error = yield* resolveThreadTransport({
      [THREAD_SERVER_URL_ENV]: "http://127.0.0.1:3773",
    }).pipe(Effect.flip);

    expect(error.message).toContain(THREAD_SERVER_URL_ENV);
    expect(error.message).toContain(THREAD_AUTH_TOKEN_FILE_ENV);
  }).pipe(Effect.provide(layerCliRuntime)),
);

it.effect("rejects a server URL that is not an http origin", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const tokenFile = writeTokenFile(dir, "secret-token");

      for (const url of ["ftp://127.0.0.1:3773", "http://127.0.0.1:3773/mcp", "http://u:p@host"]) {
        const error = yield* resolveThreadTransport({
          [THREAD_SERVER_URL_ENV]: url,
          [THREAD_AUTH_TOKEN_FILE_ENV]: tokenFile,
        }).pipe(Effect.flip);
        expect(error.message).toContain(THREAD_SERVER_URL_ENV);
      }
    }),
  ),
);

it.effect("requires https outside loopback and accepts loopback plain http", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const tokenFile = writeTokenFile(dir, "secret-token");
      const resolve = (url: string) =>
        resolveThreadTransport({
          [THREAD_SERVER_URL_ENV]: url,
          [THREAD_AUTH_TOKEN_FILE_ENV]: tokenFile,
        });

      const insecure = yield* resolve("http://t3.example.com:3773").pipe(Effect.flip);
      expect(insecure.message).toContain("https");

      for (const url of [
        "https://t3.example.com",
        "http://127.0.0.1:3773",
        "http://localhost:3773",
        "http://[::1]:3773",
      ]) {
        expect((yield* resolve(url)).kind).toBe("remote");
      }
    }),
  ),
);

it.effect("never echoes the token from an unreadable token file", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const file = NodePath.join(dir, "token");
      NodeFS.writeFileSync(file, "secret-token", { mode: 0o644 });
      NodeFS.chmodSync(file, 0o644);

      const error = yield* resolveThreadTransport({
        [THREAD_SERVER_URL_ENV]: "http://127.0.0.1:3773",
        [THREAD_AUTH_TOKEN_FILE_ENV]: file,
      }).pipe(Effect.flip);

      expect(error.message).toContain(file);
      expect(error.message).not.toContain("secret-token");
    }),
  ),
);

it.effect("talks to the remote MCP endpoint without creating local T3 state", () =>
  withMcpServer((origin, requests) =>
    withTempDir((dir) =>
      withEnv(
        {
          [THREAD_SERVER_URL_ENV]: origin,
          [THREAD_AUTH_TOKEN_FILE_ENV]: writeTokenFile(dir, "secret-token"),
          T3CODE_HOME: NodePath.join(dir, "home"),
        },
        () =>
          Effect.gen(function* () {
            const projects = yield* withThreadTools({ baseDir: Option.none() }, (tools) =>
              tools.call(
                "t3_project_list",
                { cursor: 0, limit: 20 },
                Schema.Struct({
                  projects: Schema.Array(Schema.Unknown),
                  nextCursor: Schema.NullOr(Schema.Number),
                }),
              ),
            );

            expect(projects).toEqual({ projects: [], nextCursor: null });
            const call = requests.find((request) => request.body.includes("tools/call"));
            expect(call?.authorization).toBe("Bearer secret-token");
            expect(NodeFS.existsSync(NodePath.join(dir, "home", "userdata"))).toBe(false);
          }).pipe(Effect.provideService(GlobalFlag.LogLevel, Option.none())),
      ),
    ),
  ),
);

it.effect("refuses --base-dir when the remote transport is configured", () =>
  withMcpServer((origin) =>
    withTempDir((dir) =>
      withEnv(
        {
          [THREAD_SERVER_URL_ENV]: origin,
          [THREAD_AUTH_TOKEN_FILE_ENV]: writeTokenFile(dir, "secret-token"),
        },
        () =>
          Effect.gen(function* () {
            const error = yield* withThreadTools(
              { baseDir: Option.some(dir) },
              () => Effect.void,
            ).pipe(Effect.flip);

            expect(error.message).toContain("--base-dir");
          }).pipe(Effect.provideService(GlobalFlag.LogLevel, Option.none())),
      ),
    ),
  ),
);

it.effect("never renders the bearer token from a refused remote call", () =>
  withMcpServer(
    (origin) =>
      withTempDir((dir) =>
        withEnv(
          {
            [THREAD_SERVER_URL_ENV]: origin,
            [THREAD_AUTH_TOKEN_FILE_ENV]: writeTokenFile(dir, "secret-token"),
          },
          () =>
            Effect.gen(function* () {
              const error = yield* withThreadTools({ baseDir: Option.none() }, (tools) =>
                tools.call(
                  "t3_project_list",
                  { cursor: 0 },
                  Schema.Struct({
                    projects: Schema.Array(Schema.Unknown),
                    nextCursor: Schema.NullOr(Schema.Number),
                  }),
                ),
              ).pipe(Effect.flip);

              expect(error.message).toContain("[redacted]");
              expect(error.message).not.toContain("secret-token");
            }).pipe(Effect.provideService(GlobalFlag.LogLevel, Option.none())),
        ),
      ),
    { toolErrorMessage: "refused Authorization: Bearer secret-token" },
  ),
);
