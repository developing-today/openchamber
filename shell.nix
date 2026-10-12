# Non-flake development shell for OpenChamber.
#
# This mirrors the `devShells.x86_64-linux.default` output in flake.nix, using
# the exact same nixpkgs revision by reading flake.lock. It exists so that
# `nix-shell` (without flakes) provides the Android SDK + JDK 21 toolchain and
# `bun run mobile:build:android:debug` works with no manual environment setup.
#
# Usage:
#   nix-shell                      # Enter development environment
#   nix-shell --run "bun run mobile:build:android:debug"
#
# For flake users: `nix develop` provides an equivalent environment.

let
  # Read flake.lock to get the exact nixpkgs revision the flake uses.
  flakeLock = builtins.fromJSON (builtins.readFile ./flake.lock);
  nixpkgsLock = flakeLock.nodes.nixpkgs.locked;

  # Fetch nixpkgs with the exact hash from flake.lock.
  nixpkgs = fetchTarball {
    url = "https://github.com/${nixpkgsLock.owner}/${nixpkgsLock.repo}/archive/${nixpkgsLock.rev}.tar.gz";
    sha256 = nixpkgsLock.narHash;
  };

  pkgs = import nixpkgs {
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
in
pkgs.mkShell {
  name = "openchamber-dev";

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
}
