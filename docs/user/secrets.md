# Secrets

Keep credentials in 1Password instead of storing raw values in T3 Code, and let agents request one-off secrets in a private card instead of chat history.

> Note: **Settings → Secrets** is in preview and may not appear in every build. In-thread secret request cards from agents work everywhere.

## Connect 1Password

Install and sign in to the [1Password CLI](https://developer.1password.com/docs/cli/) (`op`) on the **T3 Code server machine**. On headless or remote servers, use a [1Password service account](./secrets-1password-service-account.md) or [1Password Connect](./secrets-1password-connect.md) so `op` doesn't wait for desktop approval.

1. Open **Settings → Secrets → Add provider** (configured per environment).
2. Enter a name and the 1Password account shorthand, sign-in address (without `https://`), or ID from `op account list`.

On a machine managed by Nix, a provider can instead read files from a directory. Add it to `settings.json` under `secretProviders` with `kind: "file"` and a `config.root`, then use a bare file name as the reference. T3 Code reads only regular files that its own user owns and that no one else can read.

## Use secret references

Credential fields in Settings (provider env vars, source control tokens, usage keys, device host tokens) include a source picker: choose **Value** for a literal value or select your 1Password provider and paste a reference like `op://vault/item/field`.

- Click the check button to verify a reference immediately.
- T3 Code reads secrets on demand (e.g. when starting a provider). If 1Password is locked, unlock it on the server and click **Refresh** in **Settings → Providers**.
- Removing a secret provider clears fields referencing it in T3 Code without touching 1Password.

## When an agent asks for a secret

When an agent calls `request_secret`, T3 Code displays a private card in the thread (web, desktop, and mobile) instead of asking you to paste into chat.

- Enter a value (or pick a 1Password reference if configured and permitted) and click **Save securely**, or **Decline**.
- Values never appear in conversation history. For T3 tools, the secret is passed directly without exposing it to the agent; for shell commands, the card tells you that the value is written to a private temporary file readable by the agent's commands for ~24 hours.

## Store a secret in agenix

On a machine whose secrets live in agenix, an agent asking for a secret to keep, such as an API token, should use an agenix card. The card shows where the value will go: the user, root module or host, the secret's name, whether it is bare or wired to environment variables, and its expiry. If it names a verify URL, that address receives the value as a Bearer token before anything is stored.

When you save, T3 Code hands the value to the store command on its standard input and keeps no copy. The agent learns only the stored path and commit. If the command fails, for example because the token did not verify, the card shows why and stays open: fix the value and save again, or decline.

The command is `canix secret store` unless `settings.json` sets `agenixSecretCommand` to another argument list. An empty list turns agenix cards off.
