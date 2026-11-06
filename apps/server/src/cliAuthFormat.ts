import type {
  AuthClientMetadata,
  AuthClientSession,
  AuthEnvironmentScope,
  AuthPairingLink,
  ServerAuthSessionMethod,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { IssuedBearerSession, IssuedPairingLink } from "./auth/EnvironmentAuth.ts";

const newline = "\n";

function serializeOptionalFields(values: ReadonlyArray<string | null | undefined>) {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function formatClientMetadata(metadata: AuthClientMetadata): string {
  const details = serializeOptionalFields([
    metadata.label,
    metadata.deviceType !== "unknown" ? metadata.deviceType : undefined,
    metadata.os,
    metadata.browser,
    metadata.ipAddress,
  ]);
  return details.length > 0 ? details.join(" | ") : "unlabeled client";
}

function toIsoString(value: DateTime.DateTime | DateTime.Utc): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

export function formatIssuedPairingCredential(
  credential: IssuedPairingLink,
  options?: {
    readonly json?: boolean;
    readonly baseUrl?: string;
  },
): string {
  const pairUrl =
    options?.baseUrl != null && options.baseUrl.length > 0
      ? (() => {
          const url = new URL("/pair", options.baseUrl);
          url.searchParams.delete("token");
          url.hash = new URLSearchParams([["token", credential.credential]]).toString();
          return url.toString();
        })()
      : undefined;

  if (options?.json) {
    return `${JSON.stringify(
      {
        id: credential.id,
        credential: credential.credential,
        ...(credential.label ? { label: credential.label } : {}),
        scopes: credential.scopes,
        expiresAt: toIsoString(credential.expiresAt),
        ...(pairUrl ? { pairUrl } : {}),
      },
      null,
      2,
    )}${newline}`;
  }

  return (
    [
      `Issued client pairing token ${credential.id}.`,
      `Token: ${credential.credential}`,
      ...(pairUrl ? [`Pair URL: ${pairUrl}`] : []),
      `Expires at: ${toIsoString(credential.expiresAt)}`,
    ].join(newline) + newline
  );
}

export function formatPairingCredentialList(
  credentials: ReadonlyArray<AuthPairingLink>,
  options?: {
    readonly json?: boolean;
  },
): string {
  if (options?.json) {
    return `${JSON.stringify(
      credentials.map((credential) => ({
        id: credential.id,
        ...(credential.label ? { label: credential.label } : {}),
        scopes: credential.permissions ?? credential.scopes,
        createdAt: toIsoString(credential.createdAt),
        expiresAt: toIsoString(credential.expiresAt),
      })),
      null,
      2,
    )}${newline}`;
  }

  if (credentials.length === 0) {
    return `No active pairing credentials.${newline}`;
  }

  return (
    credentials
      .map((credential) =>
        [
          `${credential.id}${credential.label ? ` (${credential.label})` : ""}`,
          `  scopes: ${(credential.permissions ?? credential.scopes).join(" ")}`,
          `  created: ${toIsoString(credential.createdAt)}`,
          `  expires: ${toIsoString(credential.expiresAt)}`,
        ].join(newline),
      )
      .join(`${newline}${newline}`) + newline
  );
}

export interface IssuedSessionView {
  readonly sessionId: IssuedBearerSession["sessionId"];
  readonly token: string;
  readonly expiresAt: DateTime.DateTime | DateTime.Utc;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly method?: ServerAuthSessionMethod;
  readonly client?: AuthClientMetadata;
}

export function formatIssuedSession(
  session: IssuedSessionView,
  options?: {
    readonly json?: boolean;
    readonly tokenOnly?: boolean;
    /** Write-only output: the token is never printed. */
    readonly tokenFile?: string;
  },
): string {
  if (options?.tokenOnly) {
    return `${session.token}${newline}`;
  }

  if (options?.json) {
    return `${JSON.stringify(
      {
        sessionId: session.sessionId,
        ...(options?.tokenFile === undefined ? { token: session.token } : {}),
        ...(session.method === undefined ? {} : { method: session.method }),
        scopes: session.scopes,
        subject: session.subject,
        ...(session.client === undefined ? {} : { client: session.client }),
        ...(options?.tokenFile === undefined ? {} : { tokenFile: options.tokenFile }),
        expiresAt: toIsoString(session.expiresAt),
      },
      null,
      2,
    )}${newline}`;
  }

  return (
    [
      `Issued bearer access token ${session.sessionId}.`,
      `Scopes: ${session.scopes.join(" ")}`,
      `Subject: ${session.subject}`,
      ...(session.client === undefined ? [] : [`Client: ${formatClientMetadata(session.client)}`]),
      `Expires at: ${toIsoString(session.expiresAt)}`,
      ...(options?.tokenFile === undefined
        ? [`Token: ${session.token}`]
        : [`Token file: ${options.tokenFile}`]),
    ].join(newline) + newline
  );
}

export function formatSessionList(
  sessions: ReadonlyArray<AuthClientSession>,
  options?: {
    readonly json?: boolean;
  },
): string {
  if (options?.json) {
    return `${JSON.stringify(
      sessions.map((session) => ({
        sessionId: session.sessionId,
        method: session.method,
        scopes: session.scopes,
        subject: session.subject,
        client: session.client,
        connected: session.connected,
        issuedAt: toIsoString(session.issuedAt),
        expiresAt: toIsoString(session.expiresAt),
        lastConnectedAt: session.lastConnectedAt ? toIsoString(session.lastConnectedAt) : null,
      })),
      null,
      2,
    )}${newline}`;
  }

  if (sessions.length === 0) {
    return `No active sessions.${newline}`;
  }

  return (
    sessions
      .map((session) =>
        [
          `${session.sessionId}${session.connected ? " connected" : ""}`,
          `  scopes: ${session.scopes.join(" ")}`,
          `  method: ${session.method}`,
          `  subject: ${session.subject}`,
          `  client: ${formatClientMetadata(session.client)}`,
          `  issued: ${toIsoString(session.issuedAt)}`,
          `  last connected: ${
            session.lastConnectedAt ? toIsoString(session.lastConnectedAt) : "never"
          }`,
          `  expires: ${toIsoString(session.expiresAt)}`,
        ].join(newline),
      )
      .join(`${newline}${newline}`) + newline
  );
}
