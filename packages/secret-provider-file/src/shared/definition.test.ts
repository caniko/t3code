import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { definition, FileSecretProviderConfig } from "./definition.ts";

const decodeConfig = Schema.decodeUnknownOption(FileSecretProviderConfig);

describe("file definition", () => {
  it("accepts a bare file name", () => {
    for (const reference of ["a", "antigravity-gemini-api-key", "x.y_z"]) {
      expect(definition.isReference(reference), reference).toBe(true);
    }
  });

  it("rejects paths, traversal, and names that read as a flag or a dotfile", () => {
    for (const reference of ["../x", "a/b", ".hidden", "-x", "", "x".repeat(129)]) {
      expect(definition.isReference(reference), reference).toBe(false);
    }
  });

  it("accepts an absolute directory", () => {
    expect(Option.isSome(decodeConfig({ root: "/run/user/1000/agenix" }))).toBe(true);
  });

  it("rejects a relative directory, a NUL, and an overlong path", () => {
    for (const root of ["relative/dir", "./dir", `/${"x".repeat(4096)}`, "/run/\u0000/agenix"]) {
      expect(Option.isNone(decodeConfig({ root })), root).toBe(true);
    }
  });
});
