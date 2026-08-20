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
#
# Prompt-driven side-effect knobs (warren-dc19 — replaces the retired
# stub-shell burrow runtime for scenarios 05/07/09/10; the legacy
# lib/stub-agent/agent.sh carried them first). Each knob fires only when present, so a
# knobless prompt keeps the zero-workspace-mutation contract above:
#   [sleep_ms=N]      — sleep N ms before the terminal result envelope,
#                       emitting one assistant heartbeat event per second
#   [mulch_id=ID]     — append a mulch record with id ID to
#   [mulch_ts=TS]       .mulch/expertise/<domain>.jsonl at recorded_at TS
#   [mulch_domain=D]  — domain bucket (default "acceptance")
#   [seed_id=ID]      — append a closed row for ID to .seeds/issues.jsonl
#   [seed_ts=TS]        at createdAt/updatedAt TS (append, never commit)

set -euo pipefail

_stdin="$(cat || true)"
echo "claude-path-shim: started run" >&2

# Extract the first user-turn text out of the stream-json stdin payload.
# Knobs are bracketed ASCII tokens, so a grep/sed carve is enough — no jq.
_prompt="$(printf '%s' "${_stdin}" | grep -o '"text":"[^"]*"' | head -1 | sed 's/^"text":"//; s/"$//' || true)"

sleep_ms=0
mulch_id=""
mulch_ts=""
mulch_domain="acceptance"
seed_id=""
seed_ts=""
if [[ "${_prompt}" =~ \[sleep_ms=([0-9]+)\] ]]; then sleep_ms="${BASH_REMATCH[1]}"; fi
if [[ "${_prompt}" =~ \[mulch_id=([A-Za-z0-9_.-]+)\] ]]; then mulch_id="${BASH_REMATCH[1]}"; fi
if [[ "${_prompt}" =~ \[mulch_ts=([0-9T:.Z+-]+)\] ]]; then mulch_ts="${BASH_REMATCH[1]}"; fi
if [[ "${_prompt}" =~ \[mulch_domain=([A-Za-z0-9_.-]+)\] ]]; then mulch_domain="${BASH_REMATCH[1]}"; fi
if [[ "${_prompt}" =~ \[seed_id=([A-Za-z0-9_.-]+)\] ]]; then seed_id="${BASH_REMATCH[1]}"; fi
if [[ "${_prompt}" =~ \[seed_ts=([0-9T:.Z+-]+)\] ]]; then seed_ts="${BASH_REMATCH[1]}"; fi

emit() {
  printf '%s\n' "$1"
}

# init envelope — wire-shape parity with real claude-code runs.
emit '{"type":"system","subtype":"init","session_id":"sess_stub","model":"claude-stub","tools":[]}'

# assistant text — the "at least one event" signal.
emit '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ack"}]}}'

# Knob-driven workspace side effects (pre-sleep) so a mid-flight
# cancel still reaps them.
_now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
if [ -n "${mulch_id}" ]; then
  mkdir -p ".mulch/expertise"
  _mts="${mulch_ts:-${_now}}"
  cat <<JSON >> ".mulch/expertise/${mulch_domain}.jsonl"
{"id":"${mulch_id}","domain":"${mulch_domain}","type":"convention","content":"stub agent ran successfully","recorded_at":"${_mts}","confidence":1.0}
JSON
fi
if [ -n "${seed_id}" ]; then
  mkdir -p .seeds
  _sts="${seed_ts:-${_now}}"
  cat <<JSON >> .seeds/issues.jsonl
{"id":"${seed_id}","title":"stub seed closed by acceptance harness","status":"closed","type":"task","priority":3,"createdAt":"${_sts}","updatedAt":"${_sts}"}
JSON
fi

# Remote-tracker plan-run mode (warren-53ea / scenario 43): when the
# prompt embeds `touchfile <id>`, the project has NO .seeds/ directory
# (the issue queue lives in an external warren-tracker/v1 container), so
# the shim authors an ordinary file commit — the run branch needs a
# non-zero commitsAhead so reap pushes it and the plan-run coordinator's
# PR-merge gate has a PR to poll.
if [[ "${_stdin}" =~ touchfile[[:space:]]+([A-Za-z0-9_.-]+) ]]; then
  _issue_id="${BASH_REMATCH[1]}"
  mkdir -p agent-output
  printf 'touched by the claude stub agent for %s\n' "${_issue_id}" > "agent-output/${_issue_id}.txt"
  git add "agent-output/${_issue_id}.txt" >/dev/null 2>&1 || true
  git -c user.name="claude-path-shim" -c user.email="shim@warren.invalid" \
    commit -m "claude-shim: touch ${_issue_id}" >/dev/null 2>&1 || true
fi

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

# Optional sleep so scenarios that need a live run across a cancel or a
# steer call (05/07/09/10) can drive it. Heartbeats keep the bridge fed.
if [ "${sleep_ms}" -gt 0 ]; then
  secs=$(( (sleep_ms + 999) / 1000 ))
  for ((i = 1; i <= secs; i++)); do
    sleep 1
    emit "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"heartbeat ${i}/${secs}\"}]}}"
  done
fi

# terminal result — identical numbers to claude-code-agent.sh.
emit '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.000421,"usage":{"input_tokens":1200,"output_tokens":400,"cache_read_input_tokens":5000,"cache_creation_input_tokens":200}}'

exit 0
