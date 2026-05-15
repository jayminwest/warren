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
# cache_creation_input_tokens}` — warren's bridge (src/runs/stream.ts)
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

# terminal result — this is what warren-87f9 extracts. Numbers chosen
# small but non-zero so the assertion `> 0` is unambiguous.
emit '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.000421,"usage":{"input_tokens":1200,"output_tokens":400,"cache_read_input_tokens":5000,"cache_creation_input_tokens":200}}'

exit 0
