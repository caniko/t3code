import { EnvironmentId, ThreadId, type OperatorRequestRecord } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";
import { OperatorRequestCard } from "./OperatorRequestCard";

const mocks = vi.hoisted(() => ({
  answer: vi.fn(),
  launch: vi.fn(),
  preview: vi.fn(),
  openBrowser: vi.fn(),
}));

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("thread");
const createdAt = "2026-11-27T08:00:00Z";
const request = {
  requestId: "operator-1",
  title: "Review change",
  kind: "vagrant",
  privilege: "user",
  threadId,
  status: "pending",
  waitPolicy: { mode: "async" },
  createdAt,
  updatedAt: createdAt,
} satisfies OperatorRequestRecord;

vi.mock("~/state/operatorRequests", async () => {
  const { Atom } = await import("effect/reactivity");
  const permissionAtom = () => Atom.make(true);
  return {
    operatorRequestEnvironment: {
      answer: { label: "answer", permissionAtom },
      launchDesktop: { label: "launch", permissionAtom },
      cancel: { label: "cancel", permissionAtom },
    },
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: ({ label }: { label: "answer" | "launch" }) => mocks[label],
}));
vi.mock("~/state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(EnvironmentId.make("local")) };
});
vi.mock("~/state/preview", async () => {
  const { Atom } = await import("effect/reactivity");
  return { previewEnvironment: { open: { permissionAtom: () => Atom.make(true) } } };
});
vi.mock("~/browser/previewRuntime", () => ({ previewRuntimeFor: () => "server" }));
vi.mock("../preview/openPreviewSession", () => ({ openPreviewSession: mocks.preview }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser: mocks.openBrowser }) },
}));

function setup() {
  vi.clearAllMocks();
  mocks.answer.mockResolvedValue(AsyncResult.success({ ...request, status: "submitted" }));
  mocks.launch.mockResolvedValue(AsyncResult.success({ ok: true }));
  mocks.preview.mockResolvedValue(AsyncResult.success({ tabId: "preview-tab" }));
}

it("validates required inputs and submits typed defaults and a freeform note", async () => {
  setup();
  await using screen = await render(
    <OperatorRequestCard
      environmentId={environmentId}
      request={{
        ...request,
        surfaces: {
          inlineForm: {
            allowFreeformNote: true,
            fields: [
              { id: "name", label: "Name", type: "text", required: true },
              { id: "description", label: "Description", type: "textarea", defaultValue: "Draft" },
              {
                id: "level",
                label: "Level",
                type: "select",
                options: [{ value: "low", label: "Low" }],
                defaultValue: "low",
              },
              {
                id: "regions",
                label: "Regions",
                type: "multiselect",
                options: [{ value: "west", label: "West" }],
                defaultValue: ["west"],
              },
              {
                id: "notify",
                label: "Notify?",
                type: "boolean",
                required: true,
                defaultValue: false,
              },
            ],
          },
        },
      }}
    />,
  );
  await screen.getByRole("button", { name: "Submit", exact: true }).click();
  expect(mocks.answer).not.toHaveBeenCalled();
  await screen.getByRole("textbox", { name: "Name", exact: true }).fill("Can");
  await screen.getByLabelText("Note (optional)").fill("Looks good");
  await screen.getByRole("button", { name: "Submit", exact: true }).click();
  await expect.element(screen.getByText("Submitted", { exact: true })).toBeInTheDocument();
  expect(mocks.answer).toHaveBeenCalledWith({
    environmentId,
    input: {
      requestId: request.requestId,
      threadId,
      status: "submitted",
      decidedVia: "inline",
      answers: {
        name: "Can",
        description: "Draft",
        level: "low",
        regions: ["west"],
        notify: false,
      },
      note: "Looks good",
    },
  });
});

it("submits a quick action independently of incomplete form fields", async () => {
  setup();
  await using screen = await render(
    <OperatorRequestCard
      environmentId={environmentId}
      request={{
        ...request,
        surfaces: {
          inlineForm: {
            fields: [{ id: "name", label: "Name", type: "text", required: true }],
            quickActions: [
              { id: "approve", label: "Approve", style: "primary", payload: { approved: true } },
            ],
          },
        },
      }}
    />,
  );
  await screen.getByRole("button", { name: "Approve" }).click();
  await expect.element(screen.getByText("Submitted", { exact: true })).toBeInTheDocument();
  expect(mocks.answer).toHaveBeenCalledWith({
    environmentId,
    input: {
      requestId: request.requestId,
      threadId,
      status: "submitted",
      decidedVia: "inline",
      actionId: "approve",
      answers: { approved: true },
    },
  });
});

it("allows decline without completing required fields", async () => {
  setup();
  mocks.answer.mockResolvedValue(AsyncResult.success({ ...request, status: "declined" }));
  await using screen = await render(
    <OperatorRequestCard
      environmentId={environmentId}
      request={{
        ...request,
        surfaces: {
          inlineForm: {
            fields: [{ id: "name", label: "Name", type: "text", required: true }],
          },
        },
      }}
    />,
  );
  await screen.getByRole("button", { name: "Decline" }).click();
  await expect.element(screen.getByText("Declined", { exact: true })).toBeInTheDocument();
  expect(mocks.answer).toHaveBeenCalledWith({
    environmentId,
    input: { requestId: request.requestId, threadId, status: "declined", decidedVia: "inline" },
  });
});

it("opens the thread preview and copies the CLI command without offering remote desktop launch", async () => {
  setup();
  const url = "http://127.0.0.1:4321/review?token=test";
  const writeText = vi.fn().mockResolvedValue(undefined);
  using _copy = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
  await using screen = await render(
    <OperatorRequestCard
      environmentId={environmentId}
      request={{
        ...request,
        kind: "agenix",
        privilege: "fido2-user",
        surfaces: {
          previewUrl: url,
          desktopAction: { kind: "vagrant", requestId: "desktop" },
          cliCommand: "example attend",
        },
      }}
    />,
  );
  await expect.element(screen.getByText("Agenix · FIDO2 User")).toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Open in Vagrant Desktop" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Open Interactive Preview" }).click();
  await vi.waitFor(() =>
    expect(mocks.openBrowser).toHaveBeenCalledWith({ environmentId, threadId }, "preview-tab"),
  );
  expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ url }));
  await screen.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.element(screen.getByText("Copied", { exact: true })).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith("example attend");
});

it("offers desktop launch only for the local environment and shows the result", async () => {
  setup();
  using _desktop = stubGlobal("desktopBridge", {});
  const desktopRequest = {
    ...request,
    surfaces: { desktopAction: { kind: "vagrant", requestId: "desktop" } },
  } satisfies OperatorRequestRecord;
  await using screen = await render(
    <OperatorRequestCard environmentId={environmentId} request={desktopRequest} />,
  );
  await expect.element(screen.getByText("Vagrant · User")).toBeInTheDocument();
  await screen.getByRole("button", { name: "Open in Vagrant Desktop" }).click();
  await expect.element(screen.getByText("Vagrant Desktop opened.")).toBeInTheDocument();
  await screen.rerender(
    <OperatorRequestCard environmentId={EnvironmentId.make("remote")} request={desktopRequest} />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Open in Vagrant Desktop" }))
    .not.toBeInTheDocument();
});

it("shows the terminal receipt without editable controls", async () => {
  setup();
  await using screen = await render(
    <OperatorRequestCard
      environmentId={environmentId}
      request={{
        ...request,
        kind: "ops",
        privilege: "elevated-external",
        status: "declined",
        surfaces: { inlineForm: {} },
        receipt: {
          status: "declined",
          decidedVia: "cli",
          decidedAt: createdAt,
          summary: "Change rejected",
          actionId: "reject",
          receiptPath: "/receipt.json",
          artifacts: [{ label: "Report", path: "/report.txt", sha256: "abcdef0123456789" }],
        },
      }}
    />,
  );
  for (const text of [
    "Ops · External Elevated",
    "Declined",
    "CLI",
    "Change rejected",
    "reject",
    "/receipt.json",
    "Report",
    "/report.txt",
    "abcdef012345…",
  ]) {
    await expect.element(screen.getByText(text, { exact: true })).toBeInTheDocument();
  }
  expect(screen.container.querySelector("time")?.dateTime).toBe(createdAt);
  await expect
    .element(screen.getByRole("button", { name: /submit|decline/i }))
    .not.toBeInTheDocument();
});
