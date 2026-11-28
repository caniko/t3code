import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  INCOGNITO_BROWSER_PROFILE_ID,
  isOperatorRequestTerminalStatus,
  ThreadId,
  type EnvironmentId,
  type OperatorRequestAnswerInput,
  type OperatorRequestField,
  type OperatorRequestKind,
  type OperatorRequestPrivilege,
  type OperatorRequestReceiptMetadata,
  type OperatorRequestRecord,
  type OperatorRequestStatus,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { previewRuntimeFor } from "~/browser/previewRuntime";
import { useRightPanelStore } from "~/rightPanelStore";
import { readEnvironmentSupportsServerBrowser } from "~/state/entities";
import { operatorRequestEnvironment } from "~/state/operatorRequests";
import { previewEnvironment } from "~/state/preview";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { useAtomCommand } from "~/state/use-atom-command";
import { openPreviewSession } from "../preview/openPreviewSession";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export const operatorRequestKindLabels = {
  vagrant: "Vagrant",
  agenix: "Agenix",
  ops: "Ops",
  custom: "Custom",
} satisfies Record<OperatorRequestKind, string>;

const privilegeLabels = {
  user: "User",
  "fido2-user": "FIDO2 User",
  "elevated-external": "External Elevated",
} satisfies Record<OperatorRequestPrivilege, string>;

const statusLabels = {
  pending: "Pending",
  active: "Active",
  submitted: "Submitted",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
} satisfies Record<OperatorRequestStatus, string>;

const viaLabels = {
  inline: "Inline",
  preview: "Preview",
  desktop: "Desktop",
  cli: "CLI",
  external: "External",
};
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const inboxPreviewThreadId = ThreadId.make("operator-requests-preview");
const selectClassName =
  "block w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";

export function OperatorRequestTime({ value }: { value: string }) {
  const date = Date.parse(value);
  return <time dateTime={value}>{Number.isNaN(date) ? value : dateTime.format(date)}</time>;
}

function Receipt({ receipt }: { receipt: OperatorRequestReceiptMetadata }) {
  return (
    <div className="space-y-2 text-sm">
      {receipt.summary && <p className="break-words whitespace-pre-wrap">{receipt.summary}</p>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Decided via</dt>
        <dd>{viaLabels[receipt.decidedVia]}</dd>
        <dt className="text-muted-foreground">Decided at</dt>
        <dd>
          <OperatorRequestTime value={receipt.decidedAt} />
        </dd>
        {receipt.actionId && (
          <>
            <dt className="text-muted-foreground">Action</dt>
            <dd className="break-all">
              <code>{receipt.actionId}</code>
            </dd>
          </>
        )}
        {receipt.receiptPath && (
          <>
            <dt className="text-muted-foreground">Receipt</dt>
            <dd className="break-all">
              <code>{receipt.receiptPath}</code>
            </dd>
          </>
        )}
      </dl>
      {receipt.artifacts && receipt.artifacts.length > 0 && (
        <ul aria-label="Artifacts" className="space-y-1">
          {receipt.artifacts.map((artifact) => (
            <li
              key={`${artifact.label}:${artifact.path}`}
              className="flex flex-wrap gap-x-2 break-all"
            >
              <span>{artifact.label}</span>
              <code className="text-muted-foreground">{artifact.path}</code>
              {artifact.sha256 && (
                <code className="text-muted-foreground">
                  {artifact.sha256.length > 12
                    ? `${artifact.sha256.slice(0, 12)}…`
                    : artifact.sha256}
                </code>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function defaultValue(field: OperatorRequestField) {
  const value = field.defaultValue;
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? value : field.required ? undefined : false;
    case "multiselect":
      return Array.isArray(value)
        ? (field.options
            ?.filter((option) => value.includes(option.value))
            .map(({ value }) => value) ?? [])
        : [];
    case "select":
      return typeof value === "string" && field.options?.some((option) => option.value === value)
        ? value
        : "";
    default:
      return typeof value === "string" ? value : "";
  }
}

function RequestField({
  field,
  value,
  onChange,
}: {
  field: OperatorRequestField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span>
        {field.label}
        {field.required && <span aria-hidden="true"> *</span>}
      </span>
      {field.type === "textarea" ? (
        <Textarea
          required={field.required}
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.type === "select" || field.type === "multiselect" ? (
        <select
          className={selectClassName}
          multiple={field.type === "multiselect"}
          required={field.required}
          value={Array.isArray(value) ? value : String(value ?? "")}
          onChange={(event) =>
            onChange(
              field.type === "multiselect"
                ? Array.from(event.target.selectedOptions, (option) => option.value)
                : event.target.value,
            )
          }
        >
          {field.type === "select" && <option value="">Choose an option</option>}
          {field.options?.map(({ value: option, label, description }) => (
            <option key={option} value={option}>
              {description ? `${label} (${description})` : label}
            </option>
          ))}
        </select>
      ) : field.type === "boolean" ? (
        <select
          className={selectClassName}
          required={field.required}
          value={value === undefined ? "" : String(value)}
          onChange={(event) =>
            onChange(event.target.value === "" ? undefined : event.target.value === "true")
          }
        >
          <option value="">Choose an option</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : (
        <Input
          required={field.required}
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

interface CardProps {
  readonly environmentId: EnvironmentId;
  readonly request: OperatorRequestRecord;
  readonly context?: ReactNode;
  readonly onPreviewOpened?: (threadRef: ScopedThreadRef) => Promise<void>;
  readonly onInboxPreviewOpened?: (preview: { threadRef: ScopedThreadRef; tabId: string }) => void;
  readonly allowCancel?: boolean;
  readonly local?: boolean;
}

export function OperatorRequestCard(props: CardProps) {
  return <RequestCard key={`${props.environmentId}:${props.request.requestId}`} {...props} />;
}

function RequestCard({
  environmentId,
  request,
  context,
  onPreviewOpened,
  onInboxPreviewOpened,
  allowCancel,
  local = true,
}: CardProps) {
  const inlineForm = request.surfaces?.inlineForm;
  const [answers, setAnswers] = useState<Record<string, unknown>>(() =>
    Object.fromEntries((inlineForm?.fields ?? []).map((field) => [field.id, defaultValue(field)])),
  );
  const [note, setNote] = useState("");
  const [resolved, setResolved] = useState<OperatorRequestRecord>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [copied, setCopied] = useState(false);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const canAnswer = useAtomValue(operatorRequestEnvironment.answer.permissionAtom(environmentId));
  const canCancel = useAtomValue(operatorRequestEnvironment.cancel.permissionAtom(environmentId));
  const canLaunch = useAtomValue(
    operatorRequestEnvironment.launchDesktop.permissionAtom(environmentId),
  );
  const canPreview = useAtomValue(previewEnvironment.open.permissionAtom(environmentId));
  const canGetPreviewUrl = useAtomValue(
    operatorRequestEnvironment.getPreviewUrl.permissionAtom(environmentId),
  );
  const answer = useAtomCommand(operatorRequestEnvironment.answer, { reportFailure: false });
  const cancel = useAtomCommand(operatorRequestEnvironment.cancel, { reportFailure: false });
  const launch = useAtomCommand(operatorRequestEnvironment.launchDesktop, { reportFailure: false });
  const open = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const getPreviewUrl = useAtomCommand(operatorRequestEnvironment.getPreviewUrl, {
    reportFailure: false,
  });
  const displayed =
    !isOperatorRequestTerminalStatus(request.status) && resolved ? resolved : request;
  const terminal = isOperatorRequestTerminalStatus(displayed.status);
  const { requestId, threadId, turnItemId, surfaces } = request;
  const cliCommand = surfaces?.cliCommand;
  const target = { requestId, ...(threadId && { threadId }), ...(turnItemId && { turnItemId }) };

  async function run(action: () => Promise<void>, failure: string) {
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : failure);
    } finally {
      setBusy(false);
    }
  }

  function submit(input: OperatorRequestAnswerInput) {
    return run(async () => {
      const result = await answer({
        environmentId,
        input: { ...target, decidedVia: "inline", ...input },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setResolved(result.value);
    }, "Could not answer the operator request.");
  }

  return (
    <article
      data-v2-item-type="operator_request"
      className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-3"
    >
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">
            {operatorRequestKindLabels[request.kind]} · {privilegeLabels[request.privilege]}
          </Badge>
          <Badge
            variant={
              terminal ? (displayed.status === "submitted" ? "success" : "secondary") : "info"
            }
          >
            {statusLabels[displayed.status]}
          </Badge>
          {displayed.demotedToAsync && <Badge variant="secondary">Demoted to async</Badge>}
        </div>
        <h2 className="break-words text-sm font-medium">{request.title}</h2>
        {!terminal && request.reason && (
          <p className="break-words whitespace-pre-wrap text-sm text-muted-foreground">
            {request.reason}
          </p>
        )}
        {!terminal &&
          !displayed.demotedToAsync &&
          displayed.waitPolicy.mode === "sync" &&
          displayed.waitPolicy.onTimeout === "cancel" && (
            <p className="text-xs text-muted-foreground">
              This request cancels if the wait times out.
            </p>
          )}
        {context}
      </header>
      {terminal ? (
        displayed.receipt && <Receipt receipt={displayed.receipt} />
      ) : local ? (
        <>
          {inlineForm && (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !canAnswer) return;
                const missing = inlineForm.fields?.find((field) => {
                  const value = answers[field.id];
                  return (
                    field.required &&
                    (value === undefined ||
                      (typeof value === "string" && !value.trim()) ||
                      (Array.isArray(value) && value.length === 0))
                  );
                });
                if (missing) {
                  setError(`Enter a value for ${missing.label}.`);
                  return;
                }
                void submit({
                  status: "submitted",
                  answers,
                  ...(inlineForm.allowFreeformNote && note.trim() ? { note } : {}),
                });
              }}
            >
              <fieldset disabled={!canAnswer || busy} className="min-w-0 space-y-3">
                {inlineForm.quickActions && inlineForm.quickActions.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {inlineForm.quickActions.map((action) => (
                      <Button
                        key={action.id}
                        type="button"
                        size="sm"
                        variant={
                          action.style === "danger"
                            ? "destructive"
                            : action.style === "primary"
                              ? "default"
                              : "secondary"
                        }
                        onClick={() =>
                          void submit({
                            status: "submitted",
                            actionId: action.id,
                            ...(action.payload && { answers: action.payload }),
                          })
                        }
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                )}
                {inlineForm.fields?.map((field) => (
                  <RequestField
                    key={field.id}
                    field={field}
                    value={answers[field.id]}
                    onChange={(value) => setAnswers((old) => ({ ...old, [field.id]: value }))}
                  />
                ))}
                {inlineForm.allowFreeformNote && (
                  <label className="block space-y-1 text-sm">
                    <span>Note (optional)</span>
                    <Textarea value={note} onChange={(event) => setNote(event.target.value)} />
                  </label>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm">
                    Submit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void submit({
                        status: "declined",
                        ...(inlineForm.allowFreeformNote && note.trim() ? { note } : {}),
                      })
                    }
                  >
                    Decline
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
          <div className="flex flex-wrap items-center gap-2 empty:hidden">
            {surfaces?.previewAvailable && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  !canPreview || !canGetPreviewUrl || (!threadId && !onInboxPreviewOpened) || busy
                }
                onClick={() => {
                  if (!threadId && !onInboxPreviewOpened) return;
                  const threadRef = scopeThreadRef(environmentId, threadId ?? inboxPreviewThreadId);
                  void run(async () => {
                    const remote = environmentId !== primaryEnvironmentId;
                    if (remote && !readEnvironmentSupportsServerBrowser(environmentId)) {
                      throw new Error(
                        "This environment has no server browser for its interactive preview.",
                      );
                    }
                    const preview = await getPreviewUrl({ environmentId, input: target });
                    if (preview._tag === "Failure") throw squashAtomCommandFailure(preview);
                    const previewUrl = preview.value;
                    if (previewUrl === null)
                      throw new Error("The interactive preview is no longer available.");
                    const runtime = remote ? "server" : previewRuntimeFor(environmentId);
                    const url =
                      runtime === "server"
                        ? previewUrl
                        : resolveDiscoveredServerUrl(environmentId, previewUrl);
                    const result = await openPreviewSession({
                      openPreview: open,
                      threadRef,
                      url,
                      private: true,
                      ...(runtime === undefined ? {} : { runtime }),
                      // Request URLs carry an attendance token, not a page to reopen later.
                      profileId: INCOGNITO_BROWSER_PROFILE_ID,
                    });
                    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                    if (threadId) {
                      useRightPanelStore.getState().openBrowser(threadRef, result.value.tabId);
                      await onPreviewOpened?.(threadRef);
                    } else {
                      onInboxPreviewOpened?.({ threadRef, tabId: result.value.tabId });
                    }
                  }, "Could not open the interactive preview.");
                }}
              >
                Open Interactive Preview
              </Button>
            )}
            {surfaces?.desktopAction &&
              window.desktopBridge &&
              environmentId === primaryEnvironmentId && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canLaunch || busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await launch({ environmentId, input: target });
                      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                      if (!result.value.ok)
                        throw new Error(
                          result.value.message ?? "Vagrant Desktop could not be launched.",
                        );
                      setFeedback(result.value.message ?? "Vagrant Desktop opened.");
                    }, "Vagrant Desktop could not be launched.")
                  }
                >
                  {surfaces.desktopAction.label ?? "Open in Vagrant Desktop"}
                </Button>
              )}
            {allowCancel && (
              <Button
                type="button"
                size="sm"
                variant="ghost-muted"
                disabled={!canCancel || busy}
                onClick={() =>
                  void run(async () => {
                    const result = await cancel({ environmentId, input: target });
                    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                    setResolved(result.value);
                  }, "Could not cancel the operator request.")
                }
              >
                Cancel request
              </Button>
            )}
          </div>
          {surfaces?.previewAvailable && !threadId && !onInboxPreviewOpened && (
            <p className="text-xs text-muted-foreground">The preview needs a linked thread.</p>
          )}
          {cliCommand && (
            <div className="flex items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 text-xs break-all">{cliCommand}</code>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(cliCommand);
                    setCopied(true);
                    setError(undefined);
                  } catch {
                    setCopied(false);
                    setError("Could not copy the command. Select and copy it manually.");
                  }
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          )}
          {feedback && (
            <p role="status" className="text-sm text-muted-foreground">
              {feedback}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          )}
        </>
      ) : null}
    </article>
  );
}
