#!/usr/bin/env bash
# PATH-shim `pi` stub for warren's INTERNALIZED local runtime
# (warren-ea0a, plan pl-3007 phase 3) — the pi sibling of
# claude-code-path-shim.sh (warren-0f18).
#
# The pi adapter's buildSpawnCommand execs `pi --mode rpc ...` with the
# prompt delivered as an RPC blob on stdin (src/runtime/adapters/pi.ts).
# The harness injects this stub by prepending a shim dir to the booted
# warren's PATH; profile generation probes `pi` via Bun.which and binds
# the shim dir into the sandbox. The drive loop holds stdin open until
# the `agent_end` event, so this script never reads stdin — it emits the
# same pi RPC JSONL pi-agent.sh does (a `turn_end` envelope carrying
# `message.usage.cost.total` + token counts, then `agent_end`) and
# exits, which is exactly the stream shape scenario 16 asserts on.

set -euo pipefail

echo "pi-path-shim: started (argv ignored: $*)" >&2

input_tokens=446
output_tokens=44
total_tokens=490
cost_input="0.000446"
cost_output="0.000220"
cost_total="0.000666"

emit() {
  printf '%s\n' "$1"
}

emit '{"type":"response","command":"prompt","success":true}'
emit '{"type":"agent_start"}'

# env_keys_visible — bespoke envelope for scenario 30 (warren-fe96)
# reporting which multi-provider keys warren's env plumbing surfaced
# into this sandbox. List order is fixed for deterministic substring
# matching in the scenario.
keys_visible=""
for k in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY GROQ_API_KEY MISTRAL_API_KEY DEEPSEEK_API_KEY; do
  if [ -n "${!k:-}" ]; then
    if [ -z "$keys_visible" ]; then keys_visible="\"${k}\""; else keys_visible="${keys_visible},\"${k}\""; fi
  fi
done
emit "{\"type\":\"env_keys_visible\",\"keys\":[${keys_visible}]}"

emit '{"type":"turn_start"}'
emit '{"type":"message_start","message":{"role":"user"}}'
emit '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"warren acceptance pi stub"}]}}'
emit '{"type":"message_start","message":{"role":"assistant"}}'
emit '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ack"}]}}'

# turn_end with usage — what the bridge's pi usage extractor reads.
emit "$(cat <<JSON
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"ack"}],"usage":{"input":${input_tokens},"output":${output_tokens},"cacheRead":0,"cacheWrite":0,"totalTokens":${total_tokens},"cost":{"input":${cost_input},"output":${cost_output},"cacheRead":0,"cacheWrite":0,"total":${cost_total}}}}}
JSON
)"

# agent_end — terminal envelope; the drive loop closes our stdin on it.
emit '{"type":"agent_end"}'

exit 0
