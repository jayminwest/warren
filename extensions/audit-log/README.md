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

Complete (plan pl-116e, all six steps shipped). The package polls `GET /runs`,
tails each run's NDJSON event stream with bounded `?since`/`?limit`
pages, and checkpoints a durable per-run cursor in its own SQLite store
— at-least-once delivery with resume across restarts. The normalizer
([`src/normalize.ts`](src/normalize.ts)) maps wire facts into six audit
event types (`run.dispatched`, `run.started`, `run.terminal`,
`branch.pushed`, `pr.opened`, `run.steered`) and the append-only store
([`src/audit-store.ts`](src/audit-store.ts)) applies them idempotently:
every fact carries a deterministic dedupe key, so replaying the
un-checkpointed tail after a kill is an exact no-op — no duplicate rows,
no consumed ids, no timestamp drift. Step 4 adds the export surface
([`src/server.ts`](src/server.ts)): `GET /audit-log.jsonl?since=<id>&limit=<n>`
pages the append-only log oldest-first with no skips and no duplicates
across page boundaries (`X-Audit-Log-Max-Id` lets an empty page
checkpoint), and `GET /healthz` reports collector liveness and cursor
lag (tracked vs undrained runs, last-cycle stats) without echoing
credentials. Retention prunes oldest-first via the knobs below — a
`since` cursor that falls behind the retention horizon sees a gap, not
an error. Step 5 (warren-88b8) adds the container image: the
[`Dockerfile`](Dockerfile) builds from this directory alone and runs
given only `WARREN_BASE_URL` and `WARREN_API_TOKEN`. Step 6 (warren-c8c3)
is the end-to-end smoke ([`src/smoke.test.ts`](src/smoke.test.ts)): a full
fake-warren lifecycle flows through the real pipeline, survives a
mid-stream kill between apply and checkpoint, and exports byte-identical
to the committed golden at
[`src/__golden__/smoke-export.ndjson`](src/__golden__/smoke-export.ndjson)
— each of the six audit event types exactly once. Regenerate an
intentional shape change with `AUDIT_LOG_UPDATE_GOLDENS=1 bun test
src/smoke.test.ts` and diff the fixture. See the build-order comment in
[`src/index.ts`](src/index.ts).

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
| `AUDIT_LOG_LISTEN_PORT` | no | Port for the export surface (default `8080`) |
| `AUDIT_LOG_RETENTION_MAX_ROWS` | no | Keep at most this many audit rows, oldest pruned first (default `0` = unlimited) |
| `AUDIT_LOG_RETENTION_MAX_AGE_MS` | no | Prune rows older than this many ms (default `0` = unlimited) |

The export surface is unauthenticated — warren has no extension-auth
contract to delegate to (FRICTION §4). Front it with your own proxy.

## Container

The image builds from **this directory alone** — the build context is
the package, exactly as a third party would ship theirs:

```bash
docker build -t warren-ext-audit-log .
```

Run it against a warren instance given only the two required variables;
the image pins in-image defaults for every other knob (the SQLite store
on the `/app/data` volume, the export surface on `:8080`):

```bash
docker run --rm -p 8080:8080 -v audit-log-data:/app/data \
  -e WARREN_BASE_URL=https://warren.example.com \
  -e WARREN_API_TOKEN=<token> \
  warren-ext-audit-log
```

Notes:

- The image runs as the non-root `bun` user; `/app/data` is the only
  writable state and should be a volume so the durable cursor and audit
  rows survive container replacement.
- A `HEALTHCHECK` probes `GET /healthz`, which reports collector
  liveness and cursor lag without echoing the token.
- Every `AUDIT_LOG_*` knob from the environment contract above can be
  overridden with `-e` at run time.
- There is no extension registry or distribution channel yet — building
  from a source checkout is the only way to obtain the image
  (FRICTION §4).

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
