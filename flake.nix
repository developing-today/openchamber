{
  description = "OpenChamber web runtime built from source";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    opencode-fork.url = "github:developing-today/opencode";
  };

  outputs =
    {
      self,
      nixpkgs,
      opencode-fork,
    }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      opencode = opencode-fork.packages.${system}.opencode;
      openchamber = pkgs.callPackage ./nix/package.nix {
        src = self;
        inherit opencode;
      };
      openchamber-desktop = pkgs.callPackage ./nix/desktop.nix {
        src = self;
        inherit opencode;
        inherit (openchamber) node_modules;
        electron = pkgs.electron_43;
      };
    in
    {
      packages.${system} = {
        inherit openchamber openchamber-desktop;
        default = openchamber;
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.bun
          pkgs.nodejs_24
          pkgs.git
          pkgs.openssh
        ];
      };
    };
}
