{
  description = "T3 Code fork: server CLI (t3) and desktop app (t3code-desktop) built from this tree";

  # Same nixpkgs revision canix pins, so prebuilt closures share dependencies.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/02c087f3fe673c9e317f206a627cb6b910336dbe";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
    ];
    forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

    # Override nixpkgs' t3code (package.nix wrapper + unwrapped.nix) with this tree.
    # Provider toggles (enableClaude, enableCodex, ...) stay available via
    # `.override` on the result.
    mkT3code = pkgs: let
      pnpm = pkgs.pnpm_12;
      unwrapped = pkgs.t3code.unwrapped.overrideAttrs (
        final: prev: {
          version = (builtins.fromJSON (builtins.readFile ./apps/server/package.json)).version;
          # cleanSource gives the source a `name`; resource-monitor.nix reads src.name.
          src = nixpkgs.lib.cleanSource self;
          nativeBuildInputs = (builtins.filter (p: p != pkgs.pnpm_11) prev.nativeBuildInputs) ++ [pnpm];
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit pnpm;
            inherit (final) pname version src pnpmWorkspaces;
            fetcherVersion = 4;
            hash = "sha256-uTgZxFRAW8EktSHo6pOZKWo2T3argSAFdW2nAsXkgqM=";
          };
        }
      );
    in
      # ponytail: resource monitor off; its cargoHash tracks nixpkgs' source, enable once it is overridden too.
      (pkgs.t3code.override {
        t3code-unwrapped = unwrapped;
        enableResourceMonitor = false;
      }).overrideAttrs (prev: {
        buildCommand =
          prev.buildCommand
          + ''
            wrapProgram "$out/bin/t3code-desktop" \
              --set T3CODE_DESKTOP_LAUNCHER_PATH "$out/bin/t3code-desktop"
          '';
      });
  in {
    packages = forAll (pkgs: rec {
      t3code = mkT3code pkgs;
      default = t3code;
    });
    checks = forAll (pkgs: let
      probe =
        pkgs.runCommand "t3code-launcher-probe" {
          version = "test";
          passthru = {};
          inherit (pkgs.t3code.unwrapped) meta;
        } ''
          mkdir -p "$out/bin"
          cat > "$out/bin/t3code-desktop" <<'EOF'
          #!${pkgs.runtimeShell}
          printf '%s\n' "''${T3CODE_DESKTOP_LAUNCHER_PATH-}" "$@"
          EOF
          chmod +x "$out/bin/t3code-desktop"
        '';
      withProviders = self.packages.${pkgs.stdenv.hostPlatform.system}.t3code.override {
        t3code-unwrapped = probe;
      };
      withoutProviders = withProviders.override {
        enableCodex = false;
        enableGitHub = false;
        enableGit = false;
      };
    in {
      desktop-launcher = pkgs.runCommand "t3code-desktop-launcher-test" {} ''
        url='t3code://pair?pairingUrl=https%3A%2F%2Fexample.test%2Fpair%23token%3Dfixture'
        for package in ${withProviders} ${withoutProviders}; do
          test "$(T3CODE_DESKTOP_LAUNCHER_PATH=/wrong "$package/bin/t3code-desktop" "$url")" = "$(printf '%s\n' "$package/bin/t3code-desktop" "$url")"
        done
        touch "$out"
      '';
    });
  };
}
