import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { cn } from "~/lib/utils";
import type { SharedThreadSection } from "../../sidebarProjectGrouping";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";

/** Threads other people shared with the signed-in principal, by owner and then session group. */
export function SidebarSharedThreads(props: {
  sections: ReadonlyArray<SharedThreadSection<EnvironmentThreadShell>>;
  routeThreadKey: string | null;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (props.sections.length === 0) return null;
  return (
    <section aria-label="Shared with me" className="mt-2 flex flex-col gap-px">
      <CollapsibleSectionHeader expanded={expanded} onClick={() => setExpanded(!expanded)}>
        Shared with me
      </CollapsibleSectionHeader>
      {expanded
        ? props.sections.map((section) => (
            <div key={section.ownerPrincipal} className="flex flex-col gap-px">
              <p className="px-2 pt-1 text-xs font-medium text-sidebar-foreground/90">
                {section.ownerPrincipal}
              </p>
              {section.groups.map((group) => (
                <div key={group.groupName ?? ""} className="flex flex-col gap-px">
                  {group.groupName === null ? null : (
                    <p className="px-2 text-2xs text-sidebar-muted-foreground">{group.groupName}</p>
                  )}
                  <ul className="flex flex-col gap-px">
                    {group.threads.map((thread) => {
                      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
                      const key = scopedThreadKey(threadRef);
                      return (
                        <li key={key} className="list-none">
                          <button
                            type="button"
                            aria-current={props.routeThreadKey === key ? "page" : undefined}
                            onClick={() => props.onOpenThread(threadRef)}
                            className={cn(
                              "flex h-8 w-full cursor-pointer items-center rounded-md px-2.5 text-left text-sm outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              props.routeThreadKey === key && "bg-sidebar-row-hover",
                            )}
                          >
                            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ))
        : null}
    </section>
  );
}
