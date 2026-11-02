{
  description = "T3 Code fork: server CLI (t3) and desktop app (t3code-desktop) built from this tree";

  # Same nixpkgs revision canix pins, so prebuilt closures share dependencies.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/02c087f3fe673c9e317f206a627cb6b910336dbe";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Override nixpkgs' t3code (package.nix wrapper + unwrapped.nix) with this tree.
      # Provider toggles (enableClaude, enableCodex, ...) stay available via
      # `.override` on the result.
      mkT3code =
        pkgs:
        let
          pnpm = pkgs.pnpm_12;
          unwrapped = pkgs.t3code.unwrapped.overrideAttrs (
            final: prev: {
              version = (builtins.fromJSON (builtins.readFile ./apps/server/package.json)).version;
              # cleanSource gives the source a `name`; resource-monitor.nix reads src.name.
              src = nixpkgs.lib.cleanSource self;
              nativeBuildInputs = (builtins.filter (p: p != pkgs.pnpm_11) prev.nativeBuildInputs) ++ [ pnpm ];
              pnpmDeps = pkgs.fetchPnpmDeps {
                inherit pnpm;
                inherit (final) pname version src pnpmWorkspaces;
                fetcherVersion = 4;
                hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
              };
            }
          );
        in
        # ponytail: resource monitor off; its cargoHash tracks nixpkgs' source, enable once it is overridden too.
        pkgs.t3code.override {
          t3code-unwrapped = unwrapped;
          enableResourceMonitor = false;
        };
    in
    {
      packages = forAll (pkgs: rec {
        t3code = mkT3code pkgs;
        default = t3code;
      });
    };
}
