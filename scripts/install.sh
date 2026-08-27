#!/bin/sh
# Warren CLI installer — the target of `curl -fsSL https://warren.run/install | sh`.
#
# Behavior:
#   - POSIX sh, safe under `curl | sh` (set -eu, no partial state on failure).
#   - Installs Bun (user-local, ~/.bun, no sudo) when missing.
#   - Installs @os-eco/warren-cli globally via npm when available, else bun.
#   - Verifies `warren --version` executes and prints the one next step.
#   - Idempotent: re-running upgrades in place.
#
# Env knobs (supply-chain hygiene):
#   WARREN_INSTALL_VERSION   package version spec for reproducible installs
#                            (default: latest published release).
#   WARREN_INSTALL_TARBALL   path to a local .tgz to install instead of the
#                            registry package (used by CI smoke to test the
#                            repo's own build honestly).

set -eu

# Capture the caller's PATH before we prepend anything: the post-install
# guidance must reflect the user's shell, not this script's process.
ORIGINAL_PATH="$PATH"

BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
WARREN_INSTALL_VERSION="${WARREN_INSTALL_VERSION:-latest}"
WARREN_INSTALL_TARBALL="${WARREN_INSTALL_TARBALL:-}"

log() { printf 'warren-install: %s\n' "$1"; }
die() { printf 'warren-install: error: %s\n' "$1" >&2; exit 1; }

# --- Platform detection ------------------------------------------------------

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    die "Windows is not supported directly. Install inside WSL: https://learn.microsoft.com/windows/wsl/install"
    ;;
  *) die "unsupported operating system: $os (supported: Linux, macOS)" ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "unsupported CPU architecture: $arch (supported: x64, arm64)" ;;
esac

# --- Bun bootstrap -----------------------------------------------------------

# bun's official installer writes to ~/.bun (user-writable, no sudo) and is
# itself idempotent: re-running upgrades bun in place.
ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    log "bun $(bun --version) already installed"
    return
  fi
  if [ -x "$BUN_INSTALL/bin/bun" ]; then
    log "found existing bun at $BUN_INSTALL/bin/bun"
    return
  fi
  # Dependency preflight: bun's installer needs unzip (and we need curl to
  # fetch it). A clean Debian/Ubuntu container lacks unzip, which used to
  # surface as an opaque "unzip is required" halfway through the install.
  # When we are root and apt-get exists, install the missing tools for the
  # user; otherwise die with the exact fix for their platform.
  missing=""
  for tool in curl unzip; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  if [ -n "$missing" ]; then
    if [ "$(id -u 2>/dev/null || echo nonroot)" = "0" ] && command -v apt-get >/dev/null 2>&1; then
      log "installing missing prerequisites:$missing"
      # Slim images ship empty apt lists — update before the first install.
      apt-get update -qq >/dev/null 2>&1 || true
      # shellcheck disable=SC2086
      apt-get install -y $missing >/dev/null || die "apt-get install failed for:$missing"
      for tool in curl unzip; do
        command -v "$tool" >/dev/null 2>&1 || die "$tool is still missing after apt-get install"
      done
    else
      for tool in $missing; do
        case "$tool" in
          curl)
            case "$(uname -s)" in
              Darwin) die "curl is required to install bun (curl ships with macOS — check your PATH)" ;;
              *) die "curl is required to install bun (Debian/Ubuntu: apt-get install -y curl)" ;;
            esac ;;
          unzip)
            case "$(uname -s)" in
              Darwin) die "unzip is required to install bun (unzip ships with macOS)" ;;
              *) die "unzip is required to install bun (Debian/Ubuntu: apt-get install -y unzip)" ;;
            esac ;;
        esac
      done
    fi
  fi
  log "installing bun (user-local, $BUN_INSTALL)"
  # bun's official installer is a bash script (its shebang says so), and it
  # uses `set -o pipefail`, which dash rejects. Never pipe it into `sh` —
  # `curl | sh` strips the shebang, so the CI smoke job died on dash with
  # "set: Illegal option -o pipefail". Download to a temp file and execute
  # it directly instead: honoring the shebang runs it under bash.
  installer=$(mktemp) || die "mktemp failed"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://bun.sh/install -o "$installer" || die "failed to download the bun installer"
  command -v bash >/dev/null 2>&1 || die "bash is required to install bun"
  bash "$installer" || die "bun installer failed"
  rm -f "$installer"
  [ -x "$BUN_INSTALL/bin/bun" ] || die "bun installer reported success but $BUN_INSTALL/bin/bun is missing"
  bun_version=$("$BUN_INSTALL/bin/bun" --version)
  log "installed bun $bun_version"
}

ensure_bun
# Make bun (and its global bin) visible for the rest of this script.
PATH="$BUN_INSTALL/bin:$PATH"
export PATH

# --- Warren CLI install ------------------------------------------------------

if [ -n "$WARREN_INSTALL_TARBALL" ]; then
  [ -f "$WARREN_INSTALL_TARBALL" ] || die "WARREN_INSTALL_TARBALL not found: $WARREN_INSTALL_TARBALL"
  pkg="$WARREN_INSTALL_TARBALL"
  log "installing warren from local tarball: $pkg"
elif [ "$WARREN_INSTALL_VERSION" = "latest" ]; then
  pkg="@os-eco/warren-cli"
  log "installing latest published @os-eco/warren-cli (set WARREN_INSTALL_VERSION to pin)"
else
  pkg="@os-eco/warren-cli@$WARREN_INSTALL_VERSION"
  log "installing @os-eco/warren-cli@$WARREN_INSTALL_VERSION"
fi

# Prefer npm when it works, but never sudo: if the npm global prefix is
# root-owned (the common system-node case), fall back to `bun add -g`, which
# installs into ~/.bun (user-local). A failed npm run leaves no partial state.
if command -v npm >/dev/null 2>&1; then
  log "installing via npm (found $(npm --version))"
  if npm install -g "$pkg" 2>/dev/null; then
    log "npm global install succeeded"
  else
    log "npm global prefix not user-writable; falling back to bun"
    bun add -g "$pkg" || die "bun add -g $pkg failed"
  fi
else
  log "installing via bun"
  bun add -g "$pkg" || die "bun add -g $pkg failed"
fi

# --- Verify ------------------------------------------------------------------

# The CLI runs on bun, so resolve `warren` through PATH *after* the install.
warren_bin=$(command -v warren || true)
if [ -z "$warren_bin" ]; then
  if [ -x "$BUN_INSTALL/bin/warren" ]; then
    warren_bin="$BUN_INSTALL/bin/warren"
    PATH="$BUN_INSTALL/bin:$PATH"
    export PATH
  else
    die "warren installed but no \`warren\` executable was found on PATH"
  fi
fi

log "verifying warren executes"
warren_version=$("$warren_bin" --version) || die "\`warren --version\` failed"
log "warren $warren_version installed at $warren_bin"

# --- PATH guidance (never edit rc files silently) ----------------------------

case ":$ORIGINAL_PATH:" in
  *":$BUN_INSTALL/bin:"*) ;;
  *)
    printf '\n'
    printf 'warren-install: add bun (and the warren CLI) to your PATH with:\n'
    # shellcheck disable=SC2016
    printf '  export PATH="%s/bin:$PATH"\n' "$BUN_INSTALL"
    printf '  (add that line to ~/.profile, ~/.zshrc, or ~/.bashrc)\n'
    ;;
esac

# --- Next step ----------------------------------------------------------------

printf '\nDone. Next step:\n  warren up\n'
