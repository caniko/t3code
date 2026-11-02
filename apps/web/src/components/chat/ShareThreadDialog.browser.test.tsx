import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const access = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock(import("~/state/sessionAccess"), async (original) => ({
  ...(await original()),
  useSessionAccess: (() => ({ principal: "can", snapshot: null, refresh: vi.fn() })) as never,
  useSessionAccessMutation: (() => ({ canMutate: true, mutate: access.mutate })) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: { shares: [{ principal: "dejana", role: "participant" }] },
  })) as never,
}));

import { ShareThreadDialogHost } from "./ShareThreadDialog";
import { openShareThreadDialog } from "./shareThreadDialogState";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

it("shares a session with a person and removes an existing share", async () => {
  access.mutate.mockReset().mockResolvedValue(true);
  // The dialog needs no route.
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <ShareThreadDialogHost />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await act(async () => openShareThreadDialog({ environmentId, threadId }));

  const share = page.getByRole("button", { name: "Share", exact: true });
  await userEvent.type(page.getByLabelText("Person"), "Not A Name");
  await expect.element(share).toBeDisabled();

  await userEvent.clear(page.getByLabelText("Person"));
  await userEvent.type(page.getByLabelText("Person"), "kemal");
  await userEvent.click(share);
  expect(access.mutate).toHaveBeenCalledWith({
    type: "thread.share",
    threadId,
    principal: "kemal",
    role: "viewer",
  });

  await userEvent.click(page.getByRole("button", { name: "Remove dejana" }));
  expect(access.mutate).toHaveBeenLastCalledWith({
    type: "thread.unshare",
    threadId,
    principal: "dejana",
  });
});
