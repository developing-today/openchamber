{
  description = "OpenChamber web runtime built from source";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    opencode = {
      url = "github:developing-today/opencode";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      opencode,
    }:
    let
      inherit (nixpkgs) lib;
      # Systems with a node_modules hash in nix/hashes.json.
      systems = builtins.attrNames (lib.importJSON ./nix/hashes.json).nodeModules;
      forAllSystems = f: lib.genAttrs systems (system: f system);

      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          config = {
            allowUnfree = true;
            android_sdk.accept_license = true;
          };
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          opencodePackage = opencode.packages.${system}.opencode;
          openchamber = pkgs.callPackage ./nix/package.nix {
            src = self;
            opencode = opencodePackage;
          };
          desktopArgs = {
            src = self;
            opencode = opencodePackage;
            inherit (openchamber) node_modules;
            electron = pkgs.electron_43;
          };
          openchamber-desktop =
            if pkgs.stdenv.hostPlatform.isDarwin then
              pkgs.callPackage ./nix/desktop-darwin.nix desktopArgs
            else
              pkgs.callPackage ./nix/desktop.nix desktopArgs;
        in
        {
          inherit openchamber openchamber-desktop;
          default = openchamber;
        }
      );

      # `nix run .#update-hashes` re-bakes the current system's
      # node_modules hash in nix/hashes.json (see nix/update-hashes.sh).
      apps = forAllSystems (system: {
        update-hashes = {
          type = "app";
          program = toString ./nix/update-hashes.sh;
        };
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          basePackages = [
            pkgs.bun
            pkgs.nodejs_24
            pkgs.git
            pkgs.openssh
            pkgs.unzip
            pkgs.curl
          ];
          androidSdk = pkgs.androidenv.composeAndroidPackages {
            cmdLineToolsVersion = "latest";
            buildToolsVersions = [ "35.0.0" ];
            platformVersions = [ "35" ];
            includeEmulator = false;
            includeSources = false;
            includeSystemImages = false;
          };
          androidHome = "${androidSdk.androidsdk}/libexec/android-sdk";
          javaHome = "${pkgs.jdk21.home}";
        in
        {
          default =
            if pkgs.stdenv.hostPlatform.isLinux then
              pkgs.mkShell {
                packages = basePackages ++ [
                  pkgs.jdk21
                  androidSdk.androidsdk
                  pkgs.android-tools
                ];

                ANDROID_HOME = androidHome;
                ANDROID_SDK_ROOT = androidHome;
                JAVA_HOME = javaHome;

                shellHook = ''
                  export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
                  echo "OpenChamber Android dev shell"
                  echo "  JAVA_HOME=$JAVA_HOME"
                  echo "  ANDROID_HOME=$ANDROID_HOME"
                '';
              }
            else
              pkgs.mkShell { packages = basePackages; };
        }
      );
    };
}
