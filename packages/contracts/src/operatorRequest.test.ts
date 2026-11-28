import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  isOperatorRequestTerminalStatus,
  OperatorRequestAnswerInput,
  OperatorRequestCreateInput,
  OperatorRequestReceipt,
  OperatorRequestReceiptMetadata,
  OperatorRequestWaitPolicy,
} from "./operatorRequest.ts";
import {
  WS_METHODS,
  WsOperatorRequestsAnswerRpc,
  WsOperatorRequestsCancelRpc,
  WsOperatorRequestsLaunchDesktopRpc,
  WsOperatorRequestsListPendingRpc,
  WsRpcGroup,
} from "./rpc.ts";

const decodeCreate = Schema.decodeUnknownSync(OperatorRequestCreateInput);
const decodeWaitPolicy = Schema.decodeUnknownSync(OperatorRequestWaitPolicy);
const decodeAnswerInput = Schema.decodeUnknownSync(OperatorRequestAnswerInput);
const decodeReceiptMetadata = Schema.decodeUnknownSync(OperatorRequestReceiptMetadata);
const decodeReceipt = Schema.decodeUnknownSync(OperatorRequestReceipt);
const decodeAnswerRpc = Schema.decodeUnknownSync(WsOperatorRequestsAnswerRpc.payloadSchema);
const decodeCancelRpc = Schema.decodeSync(WsOperatorRequestsCancelRpc.payloadSchema);
const decodeLaunchRpc = Schema.decodeSync(WsOperatorRequestsLaunchDesktopRpc.payloadSchema);
const decodeListRpc = Schema.decodeUnknownSync(WsOperatorRequestsListPendingRpc.payloadSchema);

describe("operator request contract", () => {
  it("accepts a real ISO deadline and bounded, non-secret JSON metadata", () => {
    const input = { kind: "ops", privilege: "user", title: "Review" };
    const extras = {
      expiresAt: "2026-11-27T12:00:00+01:00",
      metadata: { labels: ["review"], detail: { attempt: 1 }, required: true },
    };
    expect(decodeCreate({ ...input, ...extras })).toEqual({ ...input, ...extras });
    for (const invalid of [
      { expiresAt: "tomorrow" },
      { expiresAt: "2026-02-30T00:00:00Z" },
      { metadata: [] },
      { metadata: { blob: "x".repeat(4096) } },
      { metadata: { callback: () => true } },
      { metadata: { count: Infinity } },
      { metadata: { nested: { apiKey: "private" } } },
    ]) {
      expect(() => decodeCreate({ ...input, ...invalid })).toThrow();
    }
  });

  it("bounds synchronous waits", () => {
    expect(decodeWaitPolicy({ mode: "sync", syncTimeoutMs: 3_600_000 }).syncTimeoutMs).toBe(
      3_600_000,
    );
    for (const syncTimeoutMs of [0, 1.5, 3_600_001]) {
      expect(() => decodeWaitPolicy({ mode: "sync", syncTimeoutMs })).toThrow();
    }
  });

  it("distinguishes terminal statuses from answerable statuses", () => {
    expect(isOperatorRequestTerminalStatus("expired")).toBe(true);
    expect(isOperatorRequestTerminalStatus("active")).toBe(false);
    expect(() => decodeAnswerInput({ requestId: "x", status: "expired" })).toThrow();
  });

  it("strips private receipt fields from event metadata", () => {
    const receipt = decodeReceiptMetadata({
      status: "submitted",
      decidedAt: "2026-11-27T00:00:00.000Z",
      decidedVia: "inline",
      answers: { secret: "private" },
      note: "private",
    });
    expect(receipt).not.toHaveProperty("answers");
    expect(receipt).not.toHaveProperty("note");
  });

  it("decodes all surface types and full receipts", () => {
    const input = {
      kind: "vagrant",
      privilege: "fido2-user",
      title: "Sign a file",
      surfaces: {
        previewUrl: "http://127.0.0.1:4780/request?token=test",
        cliCommand: "example inspect",
        desktopAction: { kind: "vagrant", requestId: "desk:42" },
        inlineForm: {
          fields: [
            { id: "description", label: "Description", type: "textarea", required: true },
            {
              id: "choice",
              label: "Choice",
              type: "multiselect",
              options: [{ value: "a", label: "A" }],
            },
            { id: "confirm", label: "Confirm", type: "boolean", defaultValue: false },
          ],
          quickActions: [
            { id: "refuse", label: "Refuse", style: "danger", payload: { confirm: false } },
          ],
          allowFreeformNote: true,
        },
      },
    };
    expect(decodeCreate(input)).toEqual(input);
    expect(() => decodeCreate({ ...input, privilege: "root" })).toThrow();
    const receipt = {
      status: "submitted",
      decidedAt: "2026-11-27T00:00:00.000Z",
      decidedVia: "desktop",
      answers: { confirmation: true },
      artifacts: [{ label: "Log", path: "/state/result" }],
    };
    expect(decodeReceipt(receipt)).toEqual(receipt);
    expect(() => decodeReceipt({ ...receipt, decidedAt: "yesterday" })).toThrow();
  });

  it("registers the operator request RPCs with their protocol payloads", () => {
    const answer = {
      externalId: "ticket",
      status: "submitted",
      wakeThread: false,
      answers: { confirm: true },
    };
    const cancel = { requestId: "ticket", reason: "No longer needed" };
    const launch = { turnItemId: "item:ticket" };
    const list = { threadId: "thread:ticket", kind: "ops", includeTerminal: true };
    expect(decodeAnswerRpc(answer)).toEqual(answer);
    expect(decodeCancelRpc(cancel)).toEqual(cancel);
    expect(decodeLaunchRpc(launch)).toEqual(launch);
    expect(decodeListRpc(list)).toEqual(list);
    for (const tag of [
      WS_METHODS.operatorRequestsAnswer,
      WS_METHODS.operatorRequestsCancel,
      WS_METHODS.operatorRequestsLaunchDesktop,
      WS_METHODS.operatorRequestsListPending,
      WS_METHODS.operatorRequestsGetPreviewUrl,
    ]) {
      expect(WsRpcGroup.requests.has(tag)).toBe(true);
    }
  });
});
