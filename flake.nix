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
      openchamber = pkgs.callPackage ./nix/package.nix {
        src = self;
        opencode = opencode-fork.packages.${system}.opencode;
      };
    in
    {
      packages.${system} = {
        inherit openchamber;
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
