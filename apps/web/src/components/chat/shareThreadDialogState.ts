import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/** Which thread has the share dialog open; the thread menu and the command palette both close as they run. */
export const shareThreadDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("share-thread:dialog-thread"),
);

export function openShareThreadDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(shareThreadDialogThreadAtom, threadRef);
}
