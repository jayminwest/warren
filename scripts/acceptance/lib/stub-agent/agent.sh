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

ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
mulch_ts="${ts}"
seed_ts="${ts}"

# Prompt-driven overrides — burrow's [env] block can't pin per-run
# values, but the prompt arg always reaches us verbatim. Scenarios that
# need a long-running agent (steer, cancel, restart-recovery) embed
# `[sleep_ms=NNN]`; reap-roundtrip scenarios (09, 10) embed
# `[mulch_id=...]`, `[mulch_ts=...]`, `[seed_id=...]`, `[seed_ts=...]`
# to drive deterministic LWW inputs without restarting warren.
if [[ "${1:-}" =~ \[sleep_ms=([0-9]+)\] ]]; then
  sleep_ms="${BASH_REMATCH[1]}"
fi
if [[ "${1:-}" =~ \[mulch_id=([A-Za-z0-9_.-]+)\] ]]; then
  record_id="${BASH_REMATCH[1]}"
fi
if [[ "${1:-}" =~ \[mulch_ts=([0-9T:.Z+-]+)\] ]]; then
  mulch_ts="${BASH_REMATCH[1]}"
fi
if [[ "${1:-}" =~ \[seed_id=([A-Za-z0-9_.-]+)\] ]]; then
  seed_id="${BASH_REMATCH[1]}"
fi
if [[ "${1:-}" =~ \[seed_ts=([0-9T:.Z+-]+)\] ]]; then
  seed_ts="${BASH_REMATCH[1]}"
fi

# Plan-run mode (warren-ae00 / scenario 26): the coordinator dispatches
# children with a uniform prompt template like `closeseed {seed_id}`. The
# agent picks the seed id out of the prompt arg and treats this run as
# "close the named seed" — same disk side effects as the [seed_id=...]
# knob above. When the named seed appears in the comma-separated
# WARREN_STUB_NO_COMMIT_SEEDS env list, skip every workspace mutation
# (no mulch row, no seed row) so reap reports commitsAhead=0 and the
# coordinator drives the trivial-merge branch.
closeseed_mode=0
no_commit=0
if [[ "${1:-}" =~ closeseed[[:space:]]+([A-Za-z0-9_.-]+) ]]; then
  closeseed_mode=1
  seed_id="${BASH_REMATCH[1]}"
  no_commit_list=",${WARREN_STUB_NO_COMMIT_SEEDS:-},"
  if [[ "${no_commit_list}" == *",${seed_id},"* ]]; then
    no_commit=1
  fi
fi

# Ensure target directories exist (warren may not have seeded them if
# expertise_seed/workflow were empty).
mkdir -p .mulch/expertise .seeds

if [ "${no_commit}" = "1" ]; then
  echo "stub-agent: started run with prompt=\"${1:-<no-prompt>}\""
  echo "stub-agent: closeseed ${seed_id} no-commit (trivial-merge path)"
else
  # 1. Mulch record — canonical mulch JSONL shape (recorded_at is the
  #    field warren's reap LWW compares on per mx-32631d).
  mulch_path=".mulch/expertise/${domain}.jsonl"
  record="$(cat <<JSON
{"id":"${record_id}","domain":"${domain}","type":"convention","content":"stub agent ran successfully","recorded_at":"${mulch_ts}","confidence":1.0}
JSON
)"
  printf '%s\n' "${record}" >> "${mulch_path}"

  # 2. Seeds close — append a closed row keyed by seed_id. We append a
  #    full row each run; if the project already has a row with this id,
  #    reap's seeds-close mirror runs LWW on updatedAt and either
  #    overwrites or skips. Either way a deterministic outcome.
  seeds_path=".seeds/issues.jsonl"
  seed_row="$(cat <<JSON
{"id":"${seed_id}","title":"stub seed closed by acceptance harness","status":"closed","type":"task","priority":3,"createdAt":"${seed_ts}","updatedAt":"${seed_ts}"}
JSON
)"
  printf '%s\n' "${seed_row}" >> "${seeds_path}"

  # Closeseed mode (warren-ae00 / scenario 26): commit so reap's
  # branch_push has something to push and `commitsAhead > 0` opens the
  # auto-PR sub-step. Other scenarios (mulch/seeds reap roundtrips,
  # restart-recovery, …) keep the historical "append, never commit"
  # posture so their event-stream assertions stay unchanged.
  if [ "${closeseed_mode}" = "1" ]; then
    git add .mulch .seeds >/dev/null 2>&1 || true
    git -c user.name="stub-agent" -c user.email="stub@warren.invalid" \
      commit -m "stub-agent: close ${seed_id}" >/dev/null 2>&1 || true
  fi

  # 3. Agent-visible output — burrow turns this into events on the
  #    /runs/:id/stream feed, which warren mirrors into events table.
  echo "stub-agent: started run with prompt=\"${1:-<no-prompt>}\""
  echo "stub-agent: wrote mulch record id=${record_id} to ${mulch_path}"
  echo "stub-agent: wrote seed close id=${seed_id} to ${seeds_path}"
fi

# Optional sleep so scenarios that need a long-running agent (event
# stream replay, supervisor restart) can drive the kill before exit.
# Heartbeats are emitted once per second so warren's bridge has a steady
# source of new events during the kill window — without them, the bash
# script would emit its three setup lines, then sleep silently, then
# print "done" all at once, and a restart-recovery scenario couldn't
# tell whether warren actually re-bridged or just replayed cached
# history.
if [ "${sleep_ms}" -gt 0 ]; then
  # bash sleep is integer seconds; round up.
  secs=$(( (sleep_ms + 999) / 1000 ))
  echo "stub-agent: sleeping ${secs}s before exit"
  for ((i = 1; i <= secs; i++)); do
    sleep 1
    echo "stub-agent: heartbeat ${i}/${secs}"
  done
fi

echo "stub-agent: done"
exit 0
