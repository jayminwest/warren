# @warren-ext/judge

Warren's second observer extension: a **bounded, read-only LLM judge loop**
that walks terminal runs, pages their transcripts, and emits **rubric-v1
verdicts** — the locked shape from
[`docs/design/agent-analytics.md`](../../docs/design/agent-analytics.md) §12.3
with the fifteen-class behavioral failure taxonomy of §12.4 (owner cut
2026-08-15). Packaged on the [audit-log](../audit-log/README.md) conventions:
a fully standalone Bun package against warren's published HTTP surface only.

## Status

Scaffold (plan pl-17ca step 1, warren-6fc4). This step lands the package
skeleton, the environment contract, and
[`src/wire.ts`](src/wire.ts) — the verdict wire types plus
`parseVerdict`/`validateVerdict`, which enforce the §12.3 invariants at the
parse boundary:

- **Multi-label assignments** over the closed fifteen-class taxonomy, each
  with a confidence **band** (`low | medium | high` — never a float; a cheap
  judge does not own that calibration).
- **`clean` exclusivity** — a verdict that assigns `clean` assigns nothing
  else, so every denominator exists.
- **Evidence pointers** — every non-`clean` class carries at least one
  `{fromSeq, toSeq}` event sequence range; a paragraph is not auditable. An
  optional free-text note is capped at 200 characters and never substitutes
  for ranges.
- **Mandatory provenance** — judge provider + model id, rubric-version hash
  (of prompt + taxonomy), judged-at, and the USD cost of the judgment itself.

Golden fixtures under [`src/__golden__/`](src/__golden__/) pin the verdict
JSON shape. Regenerate after an intentional shape change with
`JUDGE_UPDATE_GOLDENS=1 bun test src/wire.golden.test.ts` and diff the
fixtures.

Step 4 (warren-560c) adds rubric v1 authoring:

- [`src/rubric.ts`](src/rubric.ts) — the judge system prompt rendering the
  full §12.4 taxonomy with per-class definitions and evidence-pointability
  instructions, plus `computeRubricVersion()`: a `sha256:` hash over a
  CANONICAL serialization of prompt + taxonomy (stable key order,
  normalized whitespace), so an intentional edit forks the version and
  whitespace churn does not.
- [`src/report-verdict-tool.ts`](src/report-verdict-tool.ts) — the
  `report_verdict` tool: TypeBox parameters derived from `wire.ts`
  (schema-validated at the tool layer, multi-label, banded confidence,
  evidence ranges, 200-char note cap) and the `promptGuidelines` snippet
  making `report_verdict` the MANDATORY final action — the pi session API
  surfaces no provider tool_choice forcing, so the prompt carries the
  enforcement.
- Goldens pin the rendered prompt (`rubric.system-prompt.txt`) and the
  rubricVersion hash for the canonical input (`rubric.version.json`).
  Regenerate with `JUDGE_UPDATE_GOLDENS=1 bun test src/rubric.golden.test.ts`.

- [`src/judge-tools.ts`](src/judge-tools.ts) — the judge's entire tool
  surface (§12.2): `get_run_facts`, `page_events` (cursoring NormalizedEvent
  rows with a hard per-judgment page cap), and `report_verdict` (whose
  execute terminates the loop). SDK-agnostic, so the policy is testable
  without a provider.
- [`src/judge-loop.ts`](src/judge-loop.ts) — the bounded judgment: one fresh
  session per attempt, prompt-enforced verdict emission (a plain-text end
  consumes the retry budget), bounded retries then an unjudged marker
  (`malformed_verdict` / `judge_error` / `budget_exceeded`), and
  per-judgment token/cost accounting into provenance.
- [`src/pi-session.ts`](src/pi-session.ts) — the production adapter over
  `@earendil-works/pi-coding-agent`: `createAgentSession` with
  `noTools: "builtin"` (coding toolset stripped), the model resolved via
  `ModelRuntime` from `JUDGE_PROVIDER`/`JUDGE_MODEL`, and a hermetic
  resource loader so no project files or `.pi` extensions leak into the
  judge's context.

Step 6 (warren-33da) adds the collector daemon:

- [`src/collector.ts`](src/collector.ts) — the poll loop: discover terminal
  runs via `GET /runs`, drive one judgment per run, checkpoint the cursor
  ONLY after the verdict store accepts (the audit-log delivery discipline —
  a crash never skips a run, and the store's dedupe key makes a replay an
  exact no-op). Serial by design: one judgment at a time, so the daily
  budget gate is race-free and a graceful shutdown has at most one
  in-flight judgment to finish.
- [`src/cursor-store.ts`](src/cursor-store.ts) — durable per-run judgment
  cursors keyed by run id, recording WHICH rubric version + judge model the
  accepted judgment was produced under; a new pair re-opens the run.
- [`src/spend-ledger.ts`](src/spend-ledger.ts) — the fleet-wide spend
  ledger: every judgment's accrued USD cost, summed per UTC day to enforce
  `JUDGE_DAILY_BUDGET_USD`. Spend is ledgered for verdicts AND unjudged
  markers alike — the provider billed the attempts either way.
- Budget gates (§12.5): past the daily budget the run is DEFERRED — no
  marker, no checkpoint — so it re-enters the candidate set once budget
  frees (the next UTC day). The hole stays visible in the cycle stats and
  a once-per-cycle deferral log line, never as a permanent write-off: a
  `budget_exceeded` marker would occupy the store's dedupe key and block
  the eventual real verdict (warren-5fcf). The per-judgment cap is clamped
  to the remaining daily budget so one judgment cannot push the fleet past
  the day gate. The cap is live inside an attempt too (warren-9a34): once
  accrued cost reaches it, `page_events` stops serving transcript and
  tells the model to report from the pages it has, so a successful
  judgment overshoots the cap by at most one model turn. An attempt that
  still ends without a verdict past the cap resolves with a
  `budget_exceeded` marker, because the attempts were billed.
- SIGTERM/SIGINT abort the loop between cycles; the in-flight judgment
  always finishes and checkpoints before exit.
- [`src/calibration.ts`](src/calibration.ts) — the calibration re-judge
  (§12.5): a periodic strong-model pass over a random sample of
  already-judged runs, appending verdicts under the SAME rubric version
  with the strong model's provider-qualified id (the store's dedupe key
  makes this an append, never an overwrite). Per-class and overall
  band-agreement between the cheap and strong verdicts is computed from
  the store's calibration join and persisted per rubric version in the
  `calibration_metrics` table — the disagreement rate is itself the
  tracked signal. Budget gates apply to calibration judgments too: past
  the daily budget the sampled run is DEFERRED — no marker, no store
  write, same PR #969 semantics as the collector — so it re-enters the
  candidate pool next pass instead of a `budget_exceeded` marker
  permanently excluding it. The deferral stays visible in the cycle
  stats and a once-per-pass log line. Per-judgment failures from billed
  attempts still write markers; a failure that cost $0 (an expired key, a
  model the account cannot reach) is skipped the same way a deferral is,
  because nothing was billed and a marker would exclude the run for good.
  Disabled unless `JUDGE_CALIBRATION_MODEL` is set.

Step 8 (warren-265d) adds the export surface and the end-to-end smoke:

- [`src/server.ts`](src/server.ts) — the token-gated export surface
  (below). Bearer auth from birth; there is no public projection.
- [`src/smoke.test.ts`](src/smoke.test.ts) — the end-to-end smoke against
  the fake-warren double with a stubbed judge (no provider calls):
  terminal run → judged → validated verdict exported over
  `/verdicts.jsonl`; the fleet-budget path defers the run and judges it
  once budget frees; the re-judge append path keeps both verdicts readable
  keyed by rubric version, with the stored calibration metric served by
  `/agreement`.

## Export surface

Enabled only when `JUDGE_EXPORT_TOKEN` is set — no token, no surface.
Every route except a minimal `/healthz` requires
`Authorization: Bearer <JUDGE_EXPORT_TOKEN>`; a missing or wrong token is
a flat 401, never a degraded read-only view. The token is a static
operator-minted credential (warren has no extension-auth contract to
delegate to — FRICTION §4); hold it in a secret manager and never log it.

- `GET /verdicts.jsonl?since=<id>&limit=<n>` — pages the append-only
  verdict store oldest-first (`id` is the SQLite rowid; `since` is
  exclusive). Verdict rows and `unjudged` markers export side by side —
  a budget skip is a first-class visible row, never a silent gap. The
  `X-Verdicts-Max-Id` response header is the high-water mark to
  checkpoint against, even on an empty page. A re-judge under a new
  rubric version (or the calibration pass's strong model) APPENDS a row;
  filter by `rubricVersion` + `judgeModelId` — trend lines must never
  mix rubric versions (§12.3).
- `GET /agreement` — the stored calibration metric (§12.5): the latest
  cheap↔strong band-agreement report for every rubric version that has
  one. `?rubricVersion=<v>` returns that version's latest report plus
  history (`?limit=<n>`, newest first); unknown versions 404. When
  calibration is disabled the endpoint serves an empty report list.
- `GET /healthz` — minimal liveness (status, version, uptime), the one
  unauthenticated route, and it reports no data.

## The Goodhart guard (§12.5)

Verdicts are an interpretation layer for OPERATORS, not feedback for
agents. **A verdict never enters an agent's context raw** — no prompt,
no steering message, no tool result ever carries one, because a judge
score an agent can see is a score it can optimize against. In v1 there
is **no mulch write path at all**: the only consumers are the export
surface above and the operator reading it. Any future feedback loop
arrives aggregated and delayed per §12.5, and it is a deliberate design
change, not a config knob.

## Boundary contract

This is a fully standalone Bun package: its own `package.json`, its own
lockfile, its own tests, its own container image. There are **zero imports
between `src/`/`scripts/` and `extensions/` in either direction**, enforced by
`scripts/check-layers.ts` via the `extensions-are-standalone` and
`core-does-not-import-extensions` rules in `scripts/layer-rules.json`.
Everything this package knows about warren comes from `docs/openapi.yaml` and
observed responses.

The judge holds no mutation capability of any kind (§12.2): its entire tool
surface is "page the transcript, emit a verdict," and verdicts land in the
extension's own store, never a core table.

## Environment contract

| Variable          | Required | Purpose                                   |
| ----------------- | -------- | ----------------------------------------- |
| `WARREN_BASE_URL` | yes      | Base URL of the warren instance to judge  |
| `WARREN_API_TOKEN` | yes     | Bearer credential; never logged or echoed |
| `JUDGE_PROVIDER`  | no       | Judge provider id (default `anthropic`)   |
| `JUDGE_MODEL`     | no       | Judge model id (default `claude-haiku-4-5`) |
| `JUDGE_DB_PATH`   | no       | SQLite store path (default `./data/judge.db`) |
| `JUDGE_POLL_INTERVAL_MS` | no | Delay between terminal-run discovery polls (default `30000`) |
| `JUDGE_MAX_COST_USD` | no | Per-judgment USD cost cap (default `0.25`) — the §12.5 analog of `maxCostUsd`. The legacy `JUDGE_MAX_COST_USD_PER_JUDGMENT` spelling still resolves as a fallback alias |
| `JUDGE_DAILY_BUDGET_USD` | no | Fleet-level daily judge budget (default `5`); past it, further runs are deferred to the next UTC day, visibly in the cycle stats |
| `JUDGE_MAX_RETRIES` | no | Malformed/missing-verdict retries per judgment (default `2`) |
| `JUDGE_MAX_PAGES` | no | Hard cap on events pages per judgment (default `40`); past it the tail degrades to a lower-confidence verdict, never unbounded spend |
| `JUDGE_EVENTS_PAGE_SIZE` | no | Default events page size when the model omits `limit` (default `200`) |
| `JUDGE_CALIBRATION_PROVIDER` | no | Calibration (strong-model) provider id; falls back to `JUDGE_PROVIDER` |
| `JUDGE_CALIBRATION_MODEL` | no | Calibration model id — the pass is disabled unless set |
| `JUDGE_CALIBRATION_SAMPLE_SIZE` | no | Random sample size per calibration pass (default `20`) |
| `JUDGE_CALIBRATION_INTERVAL_MS` | no | Cadence between calibration passes (default `21600000`, six hours) |
| `JUDGE_EXPORT_PORT` | no | Listen port for the export surface (default `8080`) |
| `JUDGE_EXPORT_TOKEN` | no | Static bearer credential gating `/verdicts.jsonl` and `/agreement`; unset disables the surface entirely (no public projection exists) |

The judge model pair is **provider-agnostic** — set `JUDGE_PROVIDER` and
`JUDGE_MODEL` together; nothing defaults to one vendor by hardcoding.

Model credentials follow the pi SDK
([`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent))
convention: one environment variable per provider
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …). **Only the
configured provider's key is required.** Judges always spend the deployment's
own credential (§12.5) — transcripts never leave the deployment.

## Container

The image builds from **this directory alone**:

```bash
docker build -t warren-ext-judge .
```

Run it given the two required variables plus the configured provider's model
credential:

```bash
docker run --rm -v judge-data:/app/data \
  -e WARREN_BASE_URL=https://warren.example.com \
  -e WARREN_API_TOKEN=<token> \
  -e ANTHROPIC_API_KEY=<key> \
  warren-ext-judge
```

Deploy it **beside warren** — same host or same compose project, one
judge per warren instance. The judge needs nothing from warren beyond
the two `WARREN_*` variables; it never shares a database, a volume, or a
process with warren. To serve the export surface, publish the port and
mint a static token:

```bash
docker run --rm -v judge-data:/app/data -p 8080:8080 \
  -e WARREN_BASE_URL=https://warren.example.com \
  -e WARREN_API_TOKEN=<token> \
  -e ANTHROPIC_API_KEY=<key> \
  -e JUDGE_EXPORT_TOKEN=$(openssl rand -hex 32) \
  warren-ext-judge
```

Notes:

- The image runs as the non-root `bun` user; `/app/data` is the only writable
  state and should be a volume so the verdict store survives replacement.
- Every `JUDGE_*` knob can be overridden with `-e` at run time.
- The process runs the collector daemon until SIGTERM/SIGINT; the
  in-flight judgment finishes and checkpoints before exit.

## Development

```bash
bun install        # inside extensions/judge/ — own lockfile
bun test
bun run typecheck
```

Tests co-locate with the files under test (`<name>.test.ts`), and the root
repo's quality gates (`bun run check:all`) cover the extension's lint, layer,
and guard rules from the warren repo root.
