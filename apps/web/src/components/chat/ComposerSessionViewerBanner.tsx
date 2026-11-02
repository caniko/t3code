import type { ScopedThreadRef } from "@t3tools/contracts";

import { useThreadAccessRole } from "../../state/sessionAccess";
import { ComposerBanner } from "./ComposerBanner";

/** Tells a viewer why the composer is off; its owner must make them a participant to let them send. */
export function ComposerSessionViewerBanner({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef | null;
}) {
  if (useThreadAccessRole(threadRef) !== "viewer") return null;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root variant="info">
        <ComposerBanner.Row>
          <ComposerBanner.Icon />
          <ComposerBanner.Content>
            <span className="min-w-0 flex-1 text-foreground/85">
              You can read this session. Ask its owner for participant access to send messages.
            </span>
          </ComposerBanner.Content>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
