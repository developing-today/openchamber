{
  description = "OpenChamber web runtime built from source";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    opencode.url = "github:developing-today/opencode";
  };

  outputs =
    {
      self,
      nixpkgs,
      opencode,
    }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          android_sdk.accept_license = true;
        };
      };
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
      opencodePackage = opencode.packages.${system}.opencode;
      openchamber = pkgs.callPackage ./nix/package.nix {
        src = self;
        opencode = opencodePackage;
      };
      openchamber-desktop = pkgs.callPackage ./nix/desktop.nix {
        src = self;
        opencode = opencodePackage;
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
          pkgs.jdk21
          androidSdk.androidsdk
          pkgs.android-tools
          pkgs.unzip
          pkgs.curl
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
      };
    };
}
