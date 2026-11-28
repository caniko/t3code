import { EnvironmentId, type OperatorRequestRecord } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { OperatorRequestCard } from "./OperatorRequestCard";

const mocks = vi.hoisted(() => ({
  answer: vi.fn(),
  note: vi.fn<(onChange: (value: string) => void) => void>(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@t3tools/client-runtime/state/operator-requests", () => ({
  createOperatorRequestEnvironmentAtoms: () => {
    const permissionAtom = () => null;
    return { answer: { permissionAtom }, cancel: { permissionAtom } };
  },
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.answer }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: () => null,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({ onChangeText }: { onChangeText: (value: string) => void }) => {
    mocks.note(onChangeText);
    return null;
  },
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));

it.each(["Needs another review", "  "])(
  "forwards only a nonblank note on Decline: %j",
  async (note) => {
    mocks.answer.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    mocks.note.mockClear();
    const request = {
      requestId: "operator-1",
      title: "Review",
      kind: "custom",
      privilege: "user",
      waitPolicy: { mode: "async" },
      status: "pending",
      createdAt: "2026-11-28T00:00:00Z",
      updatedAt: "2026-11-28T00:00:00Z",
      surfaces: { inlineForm: { allowFreeformNote: true } },
    } satisfies OperatorRequestRecord;
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    act(() =>
      root.render(
        <OperatorRequestCard environmentId={EnvironmentId.make("local")} request={request} local />,
      ),
    );
    act(() => mocks.note.mock.lastCall?.[0](note));
    const decline = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Decline",
    );
    expect(decline).toBeDefined();
    await act(async () => decline?.click());
    expect(mocks.answer.mock.lastCall?.[0].input).toEqual({
      requestId: request.requestId,
      status: "declined",
      decidedVia: "inline",
      ...(note.trim() ? { note } : {}),
    });
  },
);
