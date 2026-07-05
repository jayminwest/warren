#!/usr/bin/env bash
# Claude-code-shaped stub agent for warren's acceptance harness (warren-87f9).
#
# Emits claude-code stream-json stdout (matching the envelope shape
# parsed by burrow's `src/runtime/parsers/jsonl-claude.ts`). The
# acceptance harness overrides burrow's built-in `claude-code` runtime
# with a custom AgentRuntime (burrow-with-stub.ts) that swaps the spawn
# command to this script and the parser to `parseJsonlClaude` — so
# scenarios can dispatch `agent='claude-code'` against warren without
# burning a real Anthropic API key.
#
# Key envelope is the terminal `result` carrying `total_cost_usd` +
# `usage.{input_tokens,output_tokens,cache_read_input_tokens,
# cache_creation_input_tokens}` — warren's bridge (src/runs/stream/bridge.ts)
# `extractClaudeUsage` reads it on terminal detection and persists into
# `runs.cost_usd` / `runs.tokens_*`. Scenario 17 asserts the columns
# are non-null after this script exits.

set -euo pipefail

_prompt="${1:-<no-prompt>}"
echo "claude-stub-agent: started run with prompt=\"${_prompt}\"" >&2

emit() {
  printf '%s\n' "$1"
}

# init envelope — claude-code emits this first; not load-bearing for
# warren's bridge but keeps wire-shape parity with real runs.
emit '{"type":"system","subtype":"init","session_id":"sess_stub","model":"claude-stub","tools":[]}'

# assistant text — produces a `text` event on stream=stdout via the
# jsonl-claude parser's mapAssistantBlock. Useful as the "at least one
# event" signal scenario 17 polls on.
emit '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ack"}]}}'

# Plot integration (warren-06dc / pl-7937 step 8): when burrow forwards
# PLOT_ID + PLOT_ACTOR into the sandbox (warren-e26f via plan-run
# composePlotEnv), surface them as a text envelope so scenario 27 can
# assert env propagation per acceptance criterion #6. Gated on PLOT_ID
# so scenarios that don't bind a Plot (26, 17) are unaffected.
if [ -n "${PLOT_ID:-}" ]; then
  _plot_actor_safe="${PLOT_ACTOR:-<unset>}"
  emit "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"claude-stub: PLOT_ID=${PLOT_ID} PLOT_ACTOR=${_plot_actor_safe}\"}]}}"
fi

# Plan-run mode (warren-ae00 / scenario 26): when the prompt embeds
# `closeseed <id>`, close the named seed in the burrow workspace so
# reap's seeds-close-mirror + branch_push have something to mirror.
# `WARREN_STUB_NO_COMMIT_SEEDS` (comma list) names seeds whose dispatch
# should produce no commits so reap reports `commitsAhead=0` and the
# plan-run coordinator drives the trivial-merge branch.
if [[ "${_prompt}" =~ closeseed[[:space:]]+([A-Za-z0-9_.-]+) ]]; then
  _seed_id="${BASH_REMATCH[1]}"
  _no_commit_list=",${WARREN_STUB_NO_COMMIT_SEEDS:-},"
  if [[ "${_no_commit_list}" != *",${_seed_id},"* ]]; then
    _ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    mkdir -p .seeds
    cat <<JSON >> .seeds/issues.jsonl
{"id":"${_seed_id}","title":"scenario-26 ${_seed_id}","status":"closed","type":"task","priority":3,"createdAt":"${_ts}","updatedAt":"${_ts}"}
JSON
    git add .seeds >/dev/null 2>&1 || true
    git -c user.name="claude-stub-agent" -c user.email="stub@warren.invalid" \
      commit -m "claude-stub: close ${_seed_id}" >/dev/null 2>&1 || true
  fi
fi

# terminal result — this is what warren-87f9 extracts. Numbers chosen
# small but non-zero so the assertion `> 0` is unambiguous.
emit '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.000421,"usage":{"input_tokens":1200,"output_tokens":400,"cache_read_input_tokens":5000,"cache_creation_input_tokens":200}}'

exit 0
