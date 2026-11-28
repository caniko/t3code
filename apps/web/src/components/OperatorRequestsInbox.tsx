import { Link, useNavigate } from "@tanstack/react-router";
import { type OperatorRequestKind, type ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { usePendingOperatorRequests } from "~/state/operatorRequests";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import {
  OperatorRequestCard,
  operatorRequestKindLabels,
  OperatorRequestTime,
} from "./chat/OperatorRequestCard";
import { closePreviewSession } from "./preview/closePreviewSession";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";

const kinds = ["vagrant", "agenix", "ops", "custom"] as const;
const PreviewPanel = lazy(() =>
  import("./preview/PreviewPanel").then(({ PreviewPanel }) => ({ default: PreviewPanel })),
);
type InboxPreview = { readonly threadRef: ScopedThreadRef; readonly tabId: string };

export function OperatorRequestsInbox() {
  const { entries, isPending, hasError, refresh } = usePendingOperatorRequests();
  const [kind, setKind] = useState<OperatorRequestKind | "all">("all");
  const [preview, setPreview] = useState<InboxPreview | null>(null);
  const inboxRef = useRef<HTMLDivElement>(null);
  const closePreview = useAtomCommand(previewEnvironment.close);
  const closeInboxPreview = useStableCallback(({ threadRef, tabId }: InboxPreview) => {
    void closePreviewSession({ closePreview, threadRef, tabId, snapshot: null });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- release this inbox-owned preview when replaced, closed, or navigating away
  useEffect(() => {
    if (preview) return () => closeInboxPreview(preview);
  }, [preview, closeInboxPreview]);
  const navigate = useNavigate();
  const counts = { all: entries.length, vagrant: 0, agenix: 0, ops: 0, custom: 0 };
  for (const { request } of entries) counts[request.kind]++;
  const visible = kind === "all" ? entries : entries.filter(({ request }) => request.kind === kind);

  return (
    <SidebarInset className="h-dvh min-w-0 overflow-hidden">
      <div
        ref={inboxRef}
        className="mt-(--workspace-topbar-height) flex min-h-0 flex-1 flex-col md:flex-row"
      >
        <div className="scrollbar-gutter-both min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pt-4 pb-6 sm:px-6">
            <header className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-lg font-semibold">Operator requests</h1>
                <p className="text-sm text-muted-foreground">{counts.all} pending</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isPending}
                onClick={refresh}
              >
                Refresh
              </Button>
            </header>
            <div
              role="group"
              aria-label="Filter by request kind"
              className="flex flex-wrap gap-1.5"
            >
              {(["all", ...kinds] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={kind === value ? "secondary" : "ghost"}
                  aria-pressed={kind === value}
                  onClick={() => setKind(value)}
                >
                  {value === "all" ? "All" : operatorRequestKindLabels[value]} {counts[value]}
                </Button>
              ))}
            </div>
            {hasError && (
              <p role="status" className="text-sm text-destructive-foreground">
                Could not load requests from every environment.
              </p>
            )}
            {visible.length === 0 && (!hasError || isPending) && (
              <p role="status" className="text-sm text-muted-foreground">
                {isPending
                  ? "Loading operator requests…"
                  : kind === "all"
                    ? "No pending operator requests."
                    : `No pending ${operatorRequestKindLabels[kind]} requests.`}
              </p>
            )}
            <ul className="space-y-3">
              {visible.map(({ request, environmentId }) => (
                <li key={JSON.stringify([environmentId, request.requestId])}>
                  <OperatorRequestCard
                    environmentId={environmentId}
                    request={request}
                    allowCancel
                    onPreviewOpened={(threadRef) =>
                      navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(threadRef),
                      })
                    }
                    onInboxPreviewOpened={(opened) => {
                      if (inboxRef.current?.isConnected) setPreview(opened);
                      else closeInboxPreview(opened);
                    }}
                    context={
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <OperatorRequestTime value={request.createdAt} />
                        {request.threadId && (
                          <Link
                            to="/$environmentId/$threadId"
                            params={buildThreadRouteParams({
                              environmentId,
                              threadId: request.threadId,
                            })}
                            className="font-medium text-foreground underline underline-offset-2"
                          >
                            Open thread
                          </Link>
                        )}
                      </div>
                    }
                  />
                </li>
              ))}
            </ul>
          </div>
        </div>
        {preview && (
          <aside
            aria-label="Operator request preview"
            className="flex h-1/2 min-h-0 flex-col border-t border-border md:h-auto md:w-1/2 md:border-t-0 md:border-l"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
              <h2 className="text-sm font-medium">Interactive preview</h2>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPreview(null)}>
                Close preview
              </Button>
            </div>
            <div className="flex min-h-0 flex-1">
              <Suspense
                fallback={<p className="p-3 text-sm text-muted-foreground">Loading preview…</p>}
              >
                <PreviewPanel
                  mode="embedded"
                  threadRef={preview.threadRef}
                  tabId={preview.tabId}
                  visible
                />
              </Suspense>
            </div>
          </aside>
        )}
      </div>
    </SidebarInset>
  );
}
