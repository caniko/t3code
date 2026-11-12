import { SecretProviderKind } from "@t3tools/contracts";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Schema from "effect/Schema";

const MAX_ROOT_LENGTH = 4096;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const FileSecretProviderConfig = Schema.Struct({
  root: Schema.String.check(
    Schema.isMaxLength(MAX_ROOT_LENGTH),
    Schema.makeFilter((value: string) =>
      value.startsWith("/") && !value.includes("\u0000")
        ? true
        : "The directory must be an absolute path.",
    ),
  ),
});
export type FileSecretProviderConfig = typeof FileSecretProviderConfig.Type;

export const definition = defineSecretProvider({
  kind: SecretProviderKind.make("file"),
  label: "File",
  configSchema: FileSecretProviderConfig,
  // A bare file name: no slashes, no dotfiles, and never something that reads as a flag.
  isReference: (reference) => REFERENCE_PATTERN.test(reference),
  referencePlaceholder: "secret-name",
  invalidReferenceMessage: "Use a file name from the configured directory, like secret-name.",
});
