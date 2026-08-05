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

- `[worked around]` **Per-run tail fan-out.** `?follow=1` holds one
  long-lived connection per active run — linear fan-out, one failure
  domain and one reconnect loop per connection. The collector
  (warren-a0ff) instead uses BOUNDED pages (`?since=<seq>&limit=<n>`,
  which implies `follow=false` and closes after the page): no held
  connections, but O(active runs) requests per poll cycle and
  poll-interval latency. Neither option is good; the endpoint has no
  long-poll mode ("block until new events or a server-side timeout"),
  which would give one connection AND low latency AND cheap idling.
  Cost to be quantified against a live instance in step 6 (warren-c8c3).
  warren-f566 wants the same global stream for the UI.
- `[worked around]` **Discovery by polling, with an unstable page
  cursor.** `GET /runs` has no "changed since" parameter and no
  ascending order — the only sort is `started desc` over `?limit`/
  `?offset` (limit capped at 500). Every poll cycle re-lists from
  offset 0, and offset-paging a desc list while new runs arrive at the
  front can skip or re-see rows mid-page. Mitigation: cursors are keyed
  by run id and the next cycle re-lists from scratch, so discovery is
  eventually consistent. Cost: a full list scan per cycle even when
  nothing changed.
- `[worked around]` **Restart catch-up cost.** After a collector
  restart, every run that advanced while it was down must be re-tailed
  from its cursor; there is no "give me everything since sequence N
  across all runs" endpoint. `seq` (`burrowEventSeq`) is monotonic PER
  RUN, not globally, so the extension keeps one cursor row per run in
  its own SQLite and cannot order events across runs by anything but
  their `ts` strings.
- `[worked around]` **The lifecycle facts themselves are bus-only.**
  `run_dispatched`, `run_started`, `branch_pushed`, and `post_reap`
  exist only on the in-process `warren-ext/v1` bus
  (`src/runs/lifecycle-bus.ts`) — they never cross onto the HTTP wire.
  The normalizer (warren-653a) must SYNTHESIZE three of its six audit
  event types: `run.dispatched` = the run's first sighting (list row or
  first event, whichever comes first — the wire carries no dispatch fact
  and no dispatch timestamp, so queue time is invisible), `run.started`
  = the first observed event (the bridge's queued → running claim edge
  is bus-only), `run.terminal` = the list state turning terminal or a
  `reap.completed` side effect, whichever arrives first. `branch.pushed`
  is reverse-engineered from `reap.completed`'s `branchPushed` payload
  flag rather than stated as a fact. None of these carries a transition
  timestamp of its own; the store uses the source event's `ts` where one
  exists and the collector's clock otherwise.
- `[worked around]` **True lag is unknowable from outside.** Step 4's
  `/healthz` can report tracked vs undrained runs and last-cycle stats,
  but "events in warren not yet collected" is not computable: there is
  no global high-water mark to compare a cursor against, because `seq`
  is per-run and the runs list carries no event count. The health
  surface reports what the extension can observe and says so.
- `[worked around]` **Terminal runs keep answering the tail forever.**
  Nothing on the wire says "this run's event stream is complete" — the
  collector infers completeness from `run.state` being terminal on the
  LIST response plus a short page from the tail, then flags the run
  `drained` locally so later cycles skip it. A run that terminalizes
  between the list read and the tail read is caught next cycle, but the
  completeness signal is derived, never stated.

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

- `[worked around]` **Hand-derived wire types.** The run list row, the
  NDJSON event envelope, and the run lifecycle enum are re-declared in
  `src/wire.ts` with runtime narrowing at the parse boundary
  (`WireDriftError`) — the only drift detection an out-of-core package
  gets. The collector parses the minimum it needs (`id`, `state` on
  runs; the seven envelope keys on events) and tolerates the rest, so
  additive server fields never break it.
- `[filed]` **The generated OpenAPI carries no response schemas.**
  Every route's `200` in `docs/openapi.yaml` says only "Successful
  response." — there is no schema to derive types FROM. The actual
  shapes had to be recovered from the handler source
  (`src/server/handlers/runs/events.ts`, `lifecycle.ts`) and confirmed
  against a fake server. A third party without repo access could not
  have written `src/wire.ts` from the published contract alone. Filed
  as warren-b9ec.
- `[open]` **Doc drift risk.** `docs/openapi.yaml` /
  `docs/http-api.md` may lag real wire behavior on the event-tail
  endpoint (plan risk 4). Any drift found while building the collector
  (warren-a0ff) must be filed as a warren issue, not coded around.
  None found so far: the observed `?since` exclusivity, `?limit`
  implying `follow=false`, and the seven-key envelope all match the
  documented behavior.

**What the future mechanism must provide:** a versioned, published wire
contract — a protocol version string (the `warren-ext/v1` model) plus a
consumable schema artifact — so an extension fails fast on version
mismatch instead of silently misreading a drifted field.

## 3. Attribution — who did the thing

- `[worked around]` **No actor kind on lifecycle payloads.** The bus
  payload and the events stream carry what happened to a run, not who
  caused it (user dispatch vs scheduler vs plan-run coordinator vs
  steering input). The 2026-08-03 amendment to R-16 settled that actor
  *kind* suffices for audit attribution, but the field does not exist
  yet (ties to warren-3754). Hit by the normalizer in warren-653a:
  every audit row stores `actor_kind: "unknown"` — the only honest
  value. The one partial exception on the wire is `steer.sent`, whose
  payload carries `fromActor` (an identity string, not a kind); the
  normalizer preserves it in the row's detail but does not promote it,
  because an identity from one event kind is not an attribution model.
- `[open]` **Admin actions are not on any stream.** Project
  added/deleted, agent edits, and auth events are invisible to an
  observer today (`docs/design/extensions.md` §5). The audit log's
  reserved event list is the queue for these hooks.

**What the future mechanism must provide:** an additive actor-kind
field on every lifecycle fact, and a path for admin-action facts onto
the same stream, so an audit-grade observer never has to guess
causation.

## 4. Packaging — shipping and running the extension

- `[worked around]` **No auth contract for the extension's own
  surface.** Step 4's export endpoint is unauthenticated — not by
  choice but because there is nothing to delegate to. Warren cannot
  mint a scoped credential for an extension's consumers, and the
  extension cannot verify warren tokens without calling back into an
  introspection endpoint that does not exist (`/whoami` verifies the
  extension's OWN credential, not a third party's). The README tells
  operators to front the surface with their own proxy.
- `[worked around]` **Retention fights the export cursor.** An
  append-only log paged by `?since=<id>` wants immutable history;
  retention deletes the oldest rows, so a slow consumer's cursor falls
  behind the horizon and sees a silent gap. Step 4 documents the gap
  semantics rather than inventing a cursor-expiry signal the wire has
  no vocabulary for.
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
