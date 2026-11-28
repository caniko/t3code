import {
  EnvironmentId,
  INCOGNITO_BROWSER_PROFILE_ID,
  ThreadId,
  type OperatorRequestRecord,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import type { PendingOperatorRequest } from "~/state/operatorRequests";
import { OperatorRequestsInbox } from "./OperatorRequestsInbox";

const mocks = vi.hoisted(() => ({
  answer: vi.fn(),
  cancel: vi.fn(),
  getPreviewUrl: vi.fn(),
  openPreview: vi.fn(),
  closePreview: vi.fn(),
  refresh: vi.fn(),
  entries: [] as PendingOperatorRequest[],
}));
const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");
const threadId = ThreadId.make("request-thread");
const createdAt = "2026-11-27T08:00:00Z";
const vagrant = {
  requestId: "review-vm",
  title: "Review VM",
  reason: "VM needs a decision.",
  kind: "vagrant",
  privilege: "user",
  status: "pending",
  threadId,
  createdAt,
  updatedAt: createdAt,
  waitPolicy: { mode: "async" },
  surfaces: { inlineForm: { quickActions: [{ id: "approve", label: "Approve VM" }] } },
} satisfies OperatorRequestRecord;
const agenix = {
  requestId: "unlock",
  title: "Unlock key",
  kind: "agenix",
  privilege: "fido2-user",
  status: "active",
  createdAt,
  updatedAt: createdAt,
  waitPolicy: { mode: "async" },
} satisfies OperatorRequestRecord;

vi.mock("~/state/operatorRequests", async () => {
  const { Atom } = await import("effect/reactivity");
  const permissionAtom = () => Atom.make(true);
  return {
    operatorRequestEnvironment: {
      answer: { label: "answer", permissionAtom },
      launchDesktop: { label: "launch", permissionAtom },
      cancel: { label: "cancel", permissionAtom },
      getPreviewUrl: { label: "getPreviewUrl", permissionAtom },
    },
    usePendingOperatorRequests: () => ({
      entries: mocks.entries,
      isPending: false,
      hasError: false,
      refresh: mocks.refresh,
    }),
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: ({ label }: { label: "answer" | "cancel" | "closePreview" | "getPreviewUrl" }) =>
    mocks[label],
}));
vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  readEnvironmentSupportsServerBrowser: () => true,
}));
vi.mock("~/state/preview", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    previewEnvironment: {
      open: { permissionAtom: () => Atom.make(true) },
      close: { label: "closePreview" },
    },
  };
});
vi.mock("~/browser/previewRuntime", () => ({ previewRuntimeFor: () => "server" }));
vi.mock("./preview/openPreviewSession", () => ({ openPreviewSession: mocks.openPreview }));
vi.mock("./preview/PreviewPanel", () => ({
  PreviewPanel: ({ tabId }: { tabId: string }) => <p>Browser tab: {tabId}</p>,
}));

function setup() {
  vi.clearAllMocks();
  mocks.entries = [
    { request: vagrant, environmentId: primary },
    { request: agenix, environmentId: remote },
  ];
  mocks.answer.mockResolvedValue(AsyncResult.success({ ...vagrant, status: "submitted" }));
  mocks.cancel.mockResolvedValue(AsyncResult.success({ ...agenix, status: "cancelled" }));
  mocks.openPreview.mockResolvedValue(AsyncResult.success({ tabId: "ad-hoc-preview" }));
  mocks.closePreview.mockResolvedValue(AsyncResult.success(undefined));
}

it("counts connected environments' requests, filters by kind, and links only linked requests", async () => {
  setup();
  await using screen = await render(<OperatorRequestsInbox />);
  await expect.element(screen.getByText("2 pending", { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText("VM needs a decision.")).toBeInTheDocument();
  await expect
    .element(screen.getByRole("link", { name: "Open thread" }))
    .toHaveAttribute("href", "/primary/request-thread");
  await screen.getByRole("button", { name: "Agenix 1" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Agenix 1" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(screen.getByText("Unlock key")).toBeInTheDocument();
  await expect.element(screen.getByText("Review VM")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("link", { name: "Open thread" })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Ops 0" }).click();
  await expect.element(screen.getByText("No pending Ops requests.")).toBeInTheDocument();
});

it("routes inline resolution and cancellation to each request's own environment", async () => {
  setup();
  await using screen = await render(<OperatorRequestsInbox />);
  await screen.getByRole("button", { name: "Approve VM" }).click();
  await expect.element(screen.getByText("Submitted", { exact: true })).toBeInTheDocument();
  expect(mocks.answer).toHaveBeenCalledWith({
    environmentId: primary,
    input: {
      requestId: vagrant.requestId,
      threadId,
      status: "submitted",
      decidedVia: "inline",
      actionId: "approve",
    },
  });
  await screen.getByRole("button", { name: "Cancel request" }).click();
  await expect.element(screen.getByText("Cancelled", { exact: true })).toBeInTheDocument();
  expect(mocks.cancel).toHaveBeenCalledWith({
    environmentId: remote,
    input: { requestId: agenix.requestId },
  });
});

it("hosts and closes a threadless request's preview in the inbox", async () => {
  setup();
  const url = "http://127.0.0.1:4321/review?token=test";
  mocks.getPreviewUrl.mockResolvedValue(AsyncResult.success(url));
  mocks.entries = [
    { environmentId: remote, request: { ...agenix, surfaces: { previewAvailable: true } } },
  ];
  await using screen = await render(<OperatorRequestsInbox />);
  await screen.getByRole("button", { name: "Open Interactive Preview" }).click();
  await expect.element(screen.getByText("Browser tab: ad-hoc-preview")).toBeInTheDocument();
  expect(mocks.openPreview).toHaveBeenCalledWith(
    expect.objectContaining({
      url,
      profileId: INCOGNITO_BROWSER_PROFILE_ID,
      threadRef: { environmentId: remote, threadId: "operator-requests-preview" },
    }),
  );
  await screen.getByRole("button", { name: "Close preview" }).click();
  await vi.waitFor(() =>
    expect(mocks.closePreview).toHaveBeenCalledWith({
      environmentId: remote,
      input: { threadId: "operator-requests-preview", tabId: "ad-hoc-preview" },
    }),
  );
  await expect
    .element(screen.getByRole("complementary", { name: "Operator request preview" }))
    .not.toBeInTheDocument();
});
