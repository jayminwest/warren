#!/usr/bin/env bash
# Deterministic stub agent for warren's acceptance harness.
#
# Burrow dispatches us via the [[agents]] declaration in the sample
# project's burrow.toml (id = "stub-shell", command = this script).
#
# Three side effects, in order:
#   1. Append a known mulch record to .mulch/expertise/<domain>.jsonl
#      with a recorded_at timestamp warren's reap step (§11.A LWW)
#      uses to merge into the project's persistent .mulch/.
#   2. Mark the harness's known seed as `closed` in .seeds/issues.jsonl
#      so reap's seeds-close-mirror sub-step has something to mirror.
#   3. Emit a few stdout lines so warren's events table has events
#      to persist + replay.
#
# Inputs the harness controls via env:
#   WARREN_STUB_MULCH_DOMAIN   domain bucket the stub appends to
#   WARREN_STUB_MULCH_ID       stable record id (so LWW conflict resolution
#                              has something to compare against)
#   WARREN_STUB_SEED_ID        seed id the agent should mark closed
#   WARREN_STUB_SLEEP_MS       sleep before exit (lets the stream-recovery
#                              scenario kill warren mid-run); default 0
#
# Workspace layout (per burrow conventions): we are cd'd into the burrow
# workspace root; .mulch/ and .seeds/ are seeded by warren before we run.

set -euo pipefail

domain="${WARREN_STUB_MULCH_DOMAIN:-acceptance}"
record_id="${WARREN_STUB_MULCH_ID:-mx-stub-$$}"
seed_id="${WARREN_STUB_SEED_ID:-stub-seed-1}"
sleep_ms="${WARREN_STUB_SLEEP_MS:-0}"

# Prompt-driven sleep override — burrow's [env] block can't pin per-run
# values, but the prompt arg always reaches us verbatim. Scenarios that
# need a long-running agent (steer, cancel, restart-recovery) embed
# `[sleep_ms=NNN]` anywhere in the prompt and we honour it.
if [[ "${1:-}" =~ \[sleep_ms=([0-9]+)\] ]]; then
  sleep_ms="${BASH_REMATCH[1]}"
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

# Ensure target directories exist (warren may not have seeded them if
# expertise_seed/workflow were empty).
mkdir -p .mulch/expertise .seeds

# 1. Mulch record — canonical mulch JSONL shape (recorded_at is the
#    field warren's reap LWW compares on per mx-32631d).
mulch_path=".mulch/expertise/${domain}.jsonl"
record="$(cat <<JSON
{"id":"${record_id}","domain":"${domain}","type":"convention","content":"stub agent ran successfully","recorded_at":"${ts}","confidence":1.0}
JSON
)"
printf '%s\n' "${record}" >> "${mulch_path}"

# 2. Seeds close — append a closed row keyed by seed_id. We append a
#    full row each run; if the project already has a row with this id,
#    reap's seeds-close mirror runs LWW on updatedAt and either
#    overwrites or skips. Either way a deterministic outcome.
seeds_path=".seeds/issues.jsonl"
seed_row="$(cat <<JSON
{"id":"${seed_id}","title":"stub seed closed by acceptance harness","status":"closed","type":"task","priority":3,"createdAt":"${ts}","updatedAt":"${ts}"}
JSON
)"
printf '%s\n' "${seed_row}" >> "${seeds_path}"

# 3. Agent-visible output — burrow turns this into events on the
#    /runs/:id/stream feed, which warren mirrors into events table.
echo "stub-agent: started run with prompt=\"${1:-<no-prompt>}\""
echo "stub-agent: wrote mulch record id=${record_id} to ${mulch_path}"
echo "stub-agent: wrote seed close id=${seed_id} to ${seeds_path}"

# Optional sleep so scenarios that need a long-running agent (event
# stream replay, supervisor restart) can drive the kill before exit.
if [ "${sleep_ms}" -gt 0 ]; then
  # bash sleep is integer seconds; round up.
  secs=$(( (sleep_ms + 999) / 1000 ))
  echo "stub-agent: sleeping ${secs}s before exit"
  sleep "${secs}"
fi

echo "stub-agent: done"
exit 0
