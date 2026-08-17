#!/usr/bin/env bash
# Fake `bwrap` for warren's acceptance harness (warren-dc19).
#
# Warren's internalized local engine spawns every agent through
# `bwrap` (src/sandbox/sandbox.ts → buildBwrapArgv). Acceptance runs on
# hosts without bubblewrap and without CAP_SYS_ADMIN (dev containers,
# the nightly runner), where the real binary can't exist. The harness
# isn't testing namespace isolation — it's testing warren's HTTP/reap
# contract — so this shim parses the bwrap argv warren builds, applies
# the two mappings that matter for correctness on a namespace-less host,
# and plain-`exec`s the child:
#
#   --bind SRC /workspace      → cd into SRC (the real per-run workspace)
#   --bind SRC /home/sandbox   → export HOME=SRC when the spawn env put
#                                the sandbox home token in $HOME
#   --chdir DIR                → cd DIR, with a /workspace prefix remapped
#                                onto the bound workspace source
#   --                         → everything after it is the child argv
#
# All other bwrap flags are namespace setup and drop away. Env arrives
# via the spawn's env option (burrow-ab95) and survives exec. cgroup
# metering is unaffected — it wraps argv OUTSIDE bwrap
# (src/sandbox/cgroup.ts wrapArgvForCgroup), and degrades to unlimited
# when the host tree isn't writable.
#
# Mirrors the bwrap shim scenario 11 installs for `warren doctor`, but
# this one must actually run the payload, so it lives as a committed
# fixture next to the claude PATH-shim.

set -euo pipefail

workspace_src=""
home_src=""
chdir=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      break
      ;;
    --bind|--ro-bind)
      case "${3:-}" in
        /workspace) workspace_src="$2" ;;
        /home/sandbox) home_src="$2" ;;
      esac
      shift 3
      ;;
    --bind-try|--ro-bind-try|--proc|--dev|--tmpfs|--uid|--gid)
      shift 3
      ;;
    --chdir)
      chdir="$2"
      shift 2
      ;;
    *)
      # Bare flags (--unshare-all, --share-net, --die-with-parent, …).
      shift
      ;;
  esac
done

# The spawn env carries HOME=/home/sandbox (SANDBOX_HOME_PATH). Without a
# mount namespace that path doesn't exist, so point HOME at the per-run
# home the bind would have surfaced.
if [ -n "${home_src}" ] && [ "${HOME:-}" = "/home/sandbox" ]; then
  export HOME="${home_src}"
fi

if [ -n "${chdir}" ]; then
  case "${chdir}" in
    /workspace)
      [ -n "${workspace_src}" ] && cd "${workspace_src}"
      ;;
    /workspace/*)
      [ -n "${workspace_src}" ] && cd "${workspace_src}${chdir#/workspace}"
      ;;
    *)
      cd "${chdir}"
      ;;
  esac
fi

exec "$@"
