# @warren-ext/campaign-controller

Warren's first **controller** extension (plan
[pl-91b6](../../docs/design/campaign-controller.md)): a dry-run-only
upstream-contribution campaign controller. Where the
[audit-log](../audit-log/README.md) and [judge](../judge/README.md)
extensions are observers, a controller owns durable workflow state, drives
warren through its published HTTP command APIs under an explicit
operator-approved policy, and never receives a call back from warren.

V0 target ([OpenClaw](https://github.com/openclaw/openclaw) as repository
data, not hard-coded behavior): dispatch explicit approved issue work to
warren against the bot-owned fork, render cross-fork pull-request intents
without ever posting them, poll upstream review/check/comment state
read-only, deduplicate it into durable events, and journal every action
intent before any I/O. No GitHub mutation method exists in the V0 transport
at all — dry-run is enforced by absence, not by convention.

Packaged on the audit-log/judge conventions: a fully standalone Bun package
against warren's published HTTP surface only. It imports nothing from
warren's `src/` or `scripts/` (enforced in both directions by
`scripts/check-layers.ts`), and warren core never imports it.

## Status

Scaffold (plan pl-91b6 step 1, warren-772a). This step lands the package
boundary every later step builds on: own manifest, lockfile, strict
TypeScript config, Biome config, source/test tree, container image, and
this README. The only source it ships is the shared primitives downstream
issues depend on:

- [`src/clock.ts`](src/clock.ts) — injectable `Clock` and `IdGenerator`
  interfaces plus production defaults (`SystemClock`, `UuidIdGenerator`) and
  deterministic fakes (`FixedClock`, `SequentialIdGenerator`), so the
  fake-infrastructure tests never race wall time or entropy.
- [`src/errors.ts`](src/errors.ts) — the `CampaignControllerError` base
  with a stable machine-readable `code`, and the
  `ValidationError` / `ConfigError` / `StateError` / `BoundaryError`
  hierarchy every later step throws through. Error messages never carry
  secrets by construction.

Not implemented yet (later pl-91b6 steps): the campaign manifest and
repository-policy schemas, the SQLite state store and action journal, the
warren and GitHub clients, validation/approval/admission, dispatch and
reconciliation, PR-intent rendering, the polling loop, and the CLI. The
entrypoint ([`src/index.ts`](src/index.ts)) is a placeholder that exits
`not_implemented`.

## Layout

```
src/
  clock.ts   injectable clock + id interfaces, prod defaults, test fakes
  errors.ts  campaign-controller error base types
  index.ts   entrypoint placeholder + package identity
```

## Development

```bash
bun install        # from THIS directory — the package owns its lockfile
bun test           # standalone test suite
bun run typecheck  # strict tsc, noEmit
bun run lint       # biome check src
```

## Container

```bash
docker build -t warren-ext-campaign-controller .
```

The image builds from this directory alone and runs the entrypoint
placeholder; it exits non-zero with `not_implemented` until the pl-91b6
steps land. The controller will own its storage on `/app/data`
(`CAMPAIGN_DB_PATH`).
