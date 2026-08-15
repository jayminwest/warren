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

The judge loop itself (the pi SDK driver, the warren read client, the verdict
store, the cost-capped scheduler) lands in the later steps of
[pl-17ca](../../docs/design/agent-analytics.md) — run `sd plan show pl-17ca`.

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
| `JUDGE_MAX_COST_USD_PER_JUDGMENT` | no | Per-judgment USD cost cap (default `0.25`) — the §12.5 analog of `maxCostUsd` |
| `JUDGE_DAILY_BUDGET_USD` | no | Fleet-level daily judge budget (default `5`); past it, runs are marked `unjudged` rather than degraded silently |

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

Notes:

- The image runs as the non-root `bun` user; `/app/data` is the only writable
  state and should be a volume so the verdict store survives replacement.
- Every `JUDGE_*` knob can be overridden with `-e` at run time.
- While the package is a scaffold, the process validates its environment and
  exits reporting that the loop is not yet implemented.

## Development

```bash
bun install        # inside extensions/judge/ — own lockfile
bun test
bun run typecheck
```

Tests co-locate with the files under test (`<name>.test.ts`), and the root
repo's quality gates (`bun run check:all`) cover the extension's lint, layer,
and guard rules from the warren repo root.
