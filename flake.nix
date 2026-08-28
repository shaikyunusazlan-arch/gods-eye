{
  description = "God's Eye View dev shell: pinned Node.js 24 + Chromium for the Puppeteer QA harnesses";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = nixpkgs.legacyPackages.${system};
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24 # engines: >=24.14.0 <25 || >=26 <27 — Node 24 specifically,
                      # because scripts/run-unit-tests.mjs gates its allocation
                      # budgets on the Node 24 runtime
            chromium  # browser for npm run test:track and scripts/qa-*.mjs
          ];
          # Point Puppeteer at the Nix chromium instead of its own downloaded
          # Chrome, which is dynamically linked and cannot run on NixOS.
          PUPPETEER_SKIP_DOWNLOAD = "1";
          PUPPETEER_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
        };
      });
}
