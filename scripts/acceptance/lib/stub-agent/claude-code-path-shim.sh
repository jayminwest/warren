#!/usr/bin/env bash
# PATH-shim `claude` stub for warren's INTERNALIZED local runtime
# (warren-0f18, plan pl-3007 step 12).
#
# Sibling of claude-code-agent.sh, but for the post-warren-413d spawn
# path: LocalProvider's in-process engine (src/runtime/local/drive.ts)
# resolves the claude-code adapter, whose buildSpawnCommand execs the
# bare name `claude` inside the warren-owned bwrap sandbox. The harness
# therefore injects the stub by prepending a shim dir to the booted
# warren's PATH — profile generation (src/runtime/local/profile.ts
# resolveToolchainPaths) probes `claude` via Bun.which, binds the shim
# dir into the sandbox, and prepends it to the sandbox PATH.
#
# Invocation shape (from src/runtime/adapters/claude-code.ts):
#   argv: claude --print --input-format stream-json --output-format
#         stream-json --verbose --dangerously-skip-permissions
#   stdin: the prompt as a stream-json user turn (stdin is NOT held —
#          the adapter declares no shouldCloseStdinOnEvent), so a plain
#          `cat` reads the full payload and returns.
#
# Emits the same terminal `result` envelope as claude-code-agent.sh so
# warren's bridge extractClaudeUsage + terminal detection behave
# identically across both spawn paths.
#
# `closeseed <id>` in the prompt drives the commit path: append a closed
# row to .seeds/issues.jsonl and COMMIT it, so reap sees commitsAhead > 0
# and pushes the run branch. A prompt without `closeseed` produces ZERO
# commits — the warren-c865 falsification input (a no-commit run must
# reach `succeeded`, not fail dropped_commit, because harness state now
# lands in the per-run writable $HOME instead of dirtying the worktree).

set -euo pipefail

_stdin="$(cat || true)"
echo "claude-path-shim: started run" >&2

emit() {
  printf '%s\n' "$1"
}

# init envelope — wire-shape parity with real claude-code runs.
emit '{"type":"system","subtype":"init","session_id":"sess_stub","model":"claude-stub","tools":[]}'

# assistant text — the "at least one event" signal.
emit '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ack"}]}}'

if [[ "${_stdin}" =~ closeseed[[:space:]]+([A-Za-z0-9_.-]+) ]]; then
  _seed_id="${BASH_REMATCH[1]}"
  _ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  mkdir -p .seeds
  cat <<JSON >> .seeds/issues.jsonl
{"id":"${_seed_id}","title":"scenario-41 ${_seed_id}","status":"closed","type":"task","priority":3,"createdAt":"${_ts}","updatedAt":"${_ts}"}
JSON
  git add .seeds >/dev/null 2>&1 || true
  git -c user.name="claude-path-shim" -c user.email="shim@warren.invalid" \
    commit -m "claude-shim: close ${_seed_id}" >/dev/null 2>&1 || true
fi

# terminal result — identical numbers to claude-code-agent.sh.
emit '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.000421,"usage":{"input_tokens":1200,"output_tokens":400,"cache_read_input_tokens":5000,"cache_creation_input_tokens":200}}'

exit 0
