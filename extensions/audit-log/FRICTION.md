# FRICTION.md — what building out-of-core actually costs

This file is a **primary deliverable** of plan pl-116e. It logs every
point of friction hit while building the audit-log observer against
warren's existing HTTP surface, exactly as a third party would
experience it. Each section ends with a **"what the future mechanism
must provide"** statement — this document is the input the
manifest/loader/delivery design record gets written from
(`docs/design/extensions.md` §5).

Status legend: `[open]` felt but not yet worked around · `[worked
around]` solved in-extension, at a cost · `[filed]` produced a warren
issue.

---

## 1. Delivery — getting lifecycle facts out of warren

The only delivery mechanism available today is the HTTP API itself
(PHILOSOPHY rule 5: data formats are API). There is no global lifecycle
stream, no webhook push, no subscription endpoint. The collector must
poll `GET /runs` to discover runs and then open one NDJSON event tail
per active run.

- `[open]` **Per-run tail fan-out.** One long-lived connection per
  active run. On a busy instance the collector's connection count grows
  linearly with run count, and each tail is a separate failure domain
  and a separate cursor to checkpoint. Cost to be quantified against a
  live instance in step 6 (warren-c8c3). warren-f566 wants the same
  global stream for the UI.
- `[open]` **Discovery by polling.** New runs are visible only at the
  next poll interval of `GET /runs`, so minimum event latency is the
  poll interval plus tail startup. A push channel would remove both.
- `[open]` **Restart catch-up cost.** After a collector restart, every
  run that advanced while it was down must be re-tailed from the cursor
  position; there is no "give me everything since sequence N across all
  runs" endpoint.

**What the future mechanism must provide:** a single durable,
sequenced, warren-wide lifecycle stream (push or long-poll) with one
cursor per consumer, mirroring the in-process `warren-ext/v1` bus
semantics across the process boundary — so an observer holds one
connection and one cursor regardless of run count.

## 2. Wire types — knowing what the bytes mean

There is no published client artifact a third party can depend on.
`docs/openapi.yaml` is generated from the server's `ROUTE_TABLE`, and
`src/core/wire.ts` is the canonical enum vocabulary, but both live in
warren's repo; an out-of-core package must hand-derive its own types
and keep them in sync by hand.

- `[open]` **Hand-derived wire types.** The run list row, the NDJSON
  event envelope, and the run/event lifecycle enums must be
  re-declared in this package from `docs/openapi.yaml`. Drift is
  detected only by tests against a fake or live server, not by a
  compiler.
- `[open]` **Doc drift risk.** `docs/openapi.yaml` /
  `docs/http-api.md` may lag real wire behavior on the event-tail
  endpoint (plan risk 4). Any drift found while building the collector
  (warren-a0ff) must be filed as a warren issue, not coded around.

**What the future mechanism must provide:** a versioned, published wire
contract — a protocol version string (the `warren-ext/v1` model) plus a
consumable schema artifact — so an extension fails fast on version
mismatch instead of silently misreading a drifted field.

## 3. Attribution — who did the thing

- `[open]` **No actor kind on lifecycle payloads.** The bus payload and
  the events stream carry what happened to a run, not who caused it
  (user dispatch vs scheduler vs plan-run coordinator vs steering
  input). The 2026-08-03 amendment to R-16 settled that actor *kind*
  suffices for audit attribution, but the field does not exist yet
  (ties to warren-3754). Until it lands, audit rows must record actor
  as unknown or infer it heuristically — flagged here when the
  normalizer (warren-653a) hits it.
- `[open]` **Admin actions are not on any stream.** Project
  added/deleted, agent edits, and auth events are invisible to an
  observer today (`docs/design/extensions.md` §5). The audit log's
  reserved event list is the queue for these hooks.

**What the future mechanism must provide:** an additive actor-kind
field on every lifecycle fact, and a path for admin-action facts onto
the same stream, so an audit-grade observer never has to guess
causation.

## 4. Packaging — shipping and running the extension

- `[open]` **No manifest format.** Nothing declares to warren "this
  container is an observer consuming the run lifecycle at protocol
  version X with config schema Y." This package will ship a README env
  contract (step 5) precisely because no manifest exists to write.
- `[open]` **No injected config namespace.** Configuration is
  hand-agreed environment variables (`WARREN_BASE_URL`,
  `WARREN_API_TOKEN`) that the operator must arrange to set; the
  aspirational `PLUGIN_*` injection contract
  (`docs/design/extensions.md` §3) does not exist.
- `[worked around]` **Repo boundary.** The package lives inside
  warren's repo but must build as if it did not. Cost absorbed by the
  `extensions-are-standalone` / `core-does-not-import-extensions`
  check:layers rules and by keeping every root gate scoped away from
  `extensions/` (step 1).

**What the future mechanism must provide:** a manifest declaring name,
kind, consumed contract + protocol version, image ref, and config
schema — the same artifact the loader and the site catalog read — plus
a `PLUGIN_*`-style config injection stage so operators configure an
extension once, in one place.
