# @warren-ext/audit-log

The first public warren extension: an **observer** that turns the run
lifecycle into an append-only, exportable audit log. Built as plan
[pl-116e](../../docs/design/extensions.md)'s flagship — packaged exactly
the way a third party would package theirs, against warren's existing
HTTP surfaces only, so the friction of doing so becomes the spec for
warren's future extension delivery mechanism.

An audit log that drops events is worthless, so this extension is
deliberately demanding on delivery guarantees: durable cursor,
at-least-once collection, idempotent replay.

## Status

Audit store (plan step 3, warren-653a). The package polls `GET /runs`,
tails each run's NDJSON event stream with bounded `?since`/`?limit`
pages, and checkpoints a durable per-run cursor in its own SQLite store
— at-least-once delivery with resume across restarts. The normalizer
([`src/normalize.ts`](src/normalize.ts)) maps wire facts into six audit
event types (`run.dispatched`, `run.started`, `run.terminal`,
`branch.pushed`, `pr.opened`, `run.steered`) and the append-only store
([`src/audit-store.ts`](src/audit-store.ts)) applies them idempotently:
every fact carries a deterministic dedupe key, so replaying the
un-checkpointed tail after a kill is an exact no-op — no duplicate rows,
no consumed ids, no timestamp drift. The export surface (step 4) and
the container image (step 5) land in later plan steps. See the
build-order comment in [`src/index.ts`](src/index.ts).

## Boundary contract

This is a fully standalone Bun package: its own `package.json`, its own
lockfile, its own tests, and (from step 5) its own container image.
There are **zero imports between `src/` and `extensions/` in either
direction**, enforced by `scripts/check-layers.ts` via the
`extensions-are-standalone` and `core-does-not-import-extensions` rules
in `scripts/layer-rules.json`. Everything this package knows about
warren's wire shapes comes from `docs/openapi.yaml` and observed
responses.

## Environment contract

| Variable          | Required | Purpose                                   |
| ----------------- | -------- | ----------------------------------------- |
| `WARREN_BASE_URL` | yes      | Base URL of the warren instance to watch  |
| `WARREN_API_TOKEN` | yes     | Bearer credential; never logged or echoed |
| `AUDIT_LOG_DB_PATH` | no     | SQLite store path (default `./data/audit-log.db`) |
| `AUDIT_LOG_POLL_INTERVAL_MS` | no | Delay between poll cycles (default `5000`) |
| `AUDIT_LOG_EVENTS_PAGE_SIZE` | no | Events fetched per tail page (default `500`) |

The listen port and retention knobs arrive with the steps that need them.

## Development

From this directory alone:

```bash
bun install
bun test
bun run typecheck
```

**Never commit the root `bun.lock`** when working here — commit only
`extensions/audit-log/bun.lock` (plan risk 3, mx-956e6b).

## Friction report

[`FRICTION.md`](FRICTION.md) is a primary deliverable of the plan: every
place the HTTP-tail approach hurts becomes a named requirement on the
future extension mechanism.
