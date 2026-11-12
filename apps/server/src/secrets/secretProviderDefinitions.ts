import { builtInSecretProviderDefinitions } from "@t3tools/secret-provider-definitions/registry";
import * as FileDriver from "@t3tools/secret-provider-file/server/driver";
import * as OnePasswordDriver from "@t3tools/secret-provider-onepassword/server/driver";

/** In the shared registry's order. */
export const BUILT_IN_SECRET_PROVIDER_DRIVER_LIST = [
  OnePasswordDriver.driver,
  FileDriver.driver,
] as const;

export const secretProviderDefinitions = builtInSecretProviderDefinitions;
