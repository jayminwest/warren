#!/usr/bin/env bash
# Pi-shaped stub agent for warren's acceptance harness.
#
# Emits pi RPC stdout JSONL (matching pi v0.74.0 — see burrow
# src/runtime/parsers/__golden__/pi-v0.74.0-anthropic-success.jsonl).
# burrow-with-stub.ts registers a custom AgentRuntime for the `pi` id
# whose parseEvents reads parsePiEvents, so each line below lands as a
# state_change/telemetry event in burrow's event stream and flows through
# warren's bridge. The `turn_end` envelope carries `message.usage.cost.total`
# + token counts, which warren's accumulatePiUsage (src/runs/stream.ts)
# extracts and persists into runs.cost_usd / tokens_input / tokens_output
# when it sees the `agent_end` envelope (warren-17a4).
#
# This script is the third unblock-path from the warren-17a4 seed
# update: bypass declarative outputFormats entirely by giving burrow
# a custom runtime whose parser is the real parsePiEvents.

set -euo pipefail

# Prompt arrives as $1 (promptDelivery="arg") but we only use it as a
# liveness signal — the user message content below is a fixed string
# so the script stays dependency-free.
_prompt="${1:-<no-prompt>}"
echo "pi-stub-agent: started run with prompt=\"${_prompt}\"" >&2

# Per-turn cost values — small, deterministic, and large enough to
# survive a non-zero assertion after accumulation. Pi reports `cost`
# in USD with sub-cent precision; we mirror the golden fixture's shape.
input_tokens=446
output_tokens=44
total_tokens=490
cost_input="0.000446"
cost_output="0.000220"
cost_total="0.000666"

emit() {
  # Pi emits one JSON object per line on stdout. The dispatcher reads
  # them line-by-line and feeds each to parsePiEvents.
  printf '%s\n' "$1"
}

emit '{"type":"response","command":"prompt","success":true}'
emit '{"type":"agent_start"}'
emit '{"type":"turn_start"}'

# user message echo — prompt content is included only for shape
# parity with real pi runs; no scenario asserts on it. We avoid JSON-
# encoding the live prompt to keep this script dependency-free (no jq /
# bun in the agent's PATH).
emit '{"type":"message_start","message":{"role":"user"}}'
emit '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"warren acceptance pi stub"}]}}'

# assistant message
emit '{"type":"message_start","message":{"role":"assistant"}}'
emit '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ack"}]}}'

# turn_end with usage — this is what warren-17a4 extracts.
emit "$(cat <<JSON
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"ack"}],"usage":{"input":${input_tokens},"output":${output_tokens},"cacheRead":0,"cacheWrite":0,"totalTokens":${total_tokens},"cost":{"input":${cost_input},"output":${cost_output},"cacheRead":0,"cacheWrite":0,"total":${cost_total}}}}}
JSON
)"

# agent_end — terminal envelope; warren's bridge fires
# persistInStreamPiUsage on this event and marks the run succeeded.
emit '{"type":"agent_end"}'

exit 0
