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
  Quantified by the step-6 smoke (warren-c8c3,
  `src/smoke.test.ts`): collecting ONE run's six-event lifecycle cost
  3 `GET /runs` re-lists and 3 tail pages across 3 poll cycles — 2
  requests per cycle for a single quiet run. The discovery half is
  constant waste (a full re-list even when nothing changed), and the
  tail half scales linearly in active runs, so a busy instance pays
  O(1 + active runs) requests per poll cycle for information a single
  global stream would deliver in one connection. warren-f566 wants the
  same global stream for the UI.
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
- `[worked around]` **Per-route envelope knowledge (hit again by the
  judge, warren-4e8c).** `GET /runs/:id` and `POST /runs` wrap the
  payload as `{run: {...}}` (warren-7d84), while `GET /runs` returns
  the array at the top level and `GET /runs/:id/events` is bare NDJSON.
  Nothing on the wire says which shape a route uses — the judge's read
  client hardcodes the unwrap per route, and a client that parsed the
  bare body would fail only at runtime. What the future mechanism must
  provide: one envelope convention across the API (or an explicit
  envelope marker in the published schema artifact §2 asks for), so a
  consumer never needs per-route body-shape trivia.

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
- `[worked around]` **No auth contract, second hit — the judge's export
  surface (warren-265d).** The judge's `/verdicts.jsonl` needed bearer
  auth FROM BIRTH (verdicts are operator-only under the §12.5 Goodhart
  guard; a public projection like warren's own `WARREN_AUTH=public`
  would be a leak, not a feature). Nothing has changed since the first
  hit above: warren still cannot mint a scoped credential for an
  extension's consumers, and there is still no introspection endpoint an
  extension could verify a caller's warren token against. The judge
  therefore mints its own static bearer credential
  (`JUDGE_EXPORT_TOKEN`), compares it in constant time, and disables the
  surface entirely when the variable is unset — every extension
  re-implements the same static-token gate, with its own env spelling,
  its own compare, and its own operator docs. What the future mechanism
  must provide: an extension-auth delegation contract — warren mints (or
  at least verifies) scoped credentials for an extension's own surface,
  so "token-gated from birth" is the default an extension inherits, not
  a gate each one hand-rolls.
- `[worked around]` **No manifest format.** Nothing declares to warren
  "this container is an observer consuming the run lifecycle at
  protocol version X with config schema Y." Step 5 (warren-88b8) ships
  the README environment contract table as the stand-in artifact: it is
  the only place name, kind, consumed surface, and config schema are
  written down together, and nothing machine-readable exists for a
  loader or a catalog to consume.
- `[open]` **No injected config namespace.** Configuration is
  hand-agreed environment variables (`WARREN_BASE_URL`,
  `WARREN_API_TOKEN`) that the operator must arrange to set; the
  aspirational `PLUGIN_*` injection contract
  (`docs/design/extensions.md` §3) does not exist. Step 5's Dockerfile
  papers over this by pinning in-image defaults for every optional
  knob, so the container runs given only the two required variables —
  but it is the IMAGE carrying the convention, not warren.
- `[worked around]` **No scoped observer credential.** The only way to
  read the runs list and the event tails is the operator's full-power
  admin API token — warren cannot mint a read-only or observe-scoped
  credential, and `WARREN_AUTH=public` is an instance-wide posture, not
  a credential an observer can hold. The image therefore always runs
  with more privilege than it needs, and the README has to promise
  operator-side hygiene (never logged, never echoed by `/healthz`)
  that the platform should be enforcing by construction.
- `[worked around]` **No healthcheck or readiness convention.**
  Nothing tells an orchestrator where an extension listens or how to
  probe it. Step 5 declares the image's own `HEALTHCHECK` against
  `/healthz` and `EXPOSE`s a conventional port, but warren can neither
  discover the port nor interpret the probe — the wiring is entirely
  operator convention.
- `[open]` **No distribution channel.** The image is buildable only
  from a source checkout (`docker build` in this directory): there is
  no registry, no catalog, and no version-skew policy tying an image
  tag to the warren version it can observe. A third party today would
  have to invent all three themselves.
- `[worked around]` **Repo boundary.** The package lives inside
  warren's repo but must build as if it did not. Cost absorbed by the
  `extensions-are-standalone` / `core-does-not-import-extensions`
  check:layers rules and by keeping every root gate scoped away from
  `extensions/` (step 1).

**What the future mechanism must provide:** a manifest declaring name,
kind, consumed contract + protocol version, image ref, and config
schema — the same artifact the loader and the site catalog read — plus
a `PLUGIN_*`-style config injection stage, scoped per-extension
credentials, a discoverable health probe, and a distribution channel,
so operators configure, trust, probe, and obtain an extension once, in
one place.

## 5. Judge loop — the pi SDK as the in-ecosystem driver

Logged by the judge extension (`extensions/judge/`, plan pl-17ca step 5,
warren-1dcd), which drives a bounded read-only agent loop over
`@earendil-works/pi-coding-agent` — the sanctioned in-ecosystem driver
(agent-analytics §12.2). None of this is warren-surface friction; it is
the cost of using the pi session API as a non-interactive judge.

- `[worked around]` **No provider tool_choice forcing at the session
  API.** `createAgentSession` exposes no way to force the model to call
  one final tool, so verdict emission is prompt-enforced: the
  `report_verdict` tool's `promptGuidelines` make it the mandatory final
  action, and a judgment that ends in plain text consumes the bounded
  retry budget (`judge-loop.ts`). The tool result's `terminate: true`
  hint exists and ends the loop cleanly — but a model that never calls
  the tool is only caught at the policy layer, never at the protocol
  layer.
- `[worked around]` **TypeBox package split.** The extension builds
  tool parameter schemas with `@sinclair/typebox`; pi pins the `typebox`
  package. The runtime objects are structurally identical JSON-schema
  objects, but the nominal TS types differ, so the adapter
  (`pi-session.ts`) casts `parameters` through the pi `ToolDefinition`
  type. A third party building tools outside pi's own dependency tree
  hits this on every tool.
- `[worked around]` **`promptGuidelines` shape.** pi's
  `ToolDefinition.promptGuidelines` is `string[]` (one bullet per
  entry); the extension authored its guideline block as one multi-line
  string. The adapter splits on newlines. Minor, but it is a shape a
  tool author has to discover from pi's source, not from any documented
  tool-authoring contract.
- `[worked around]` **No hermetic session preset.** The default
  resource loader pulls the cwd's AGENTS.md, skills, and `.pi`
  extensions into the session context — exactly the contamination a
  judge must not see (and the Goodhart door §12.5 forbids). The
  extension hand-implements a `ResourceLoader` returning empty
  everything plus the rubric system prompt (`JudgeResourceLoader` in
  `pi-session.ts`). A documented "empty session" preset (no project
  resources, no skills, in-memory session manager) would be the
  non-interactive-judge counterpart of the SDK's interactive defaults.

**What the future mechanism must provide:** a documented, non-interactive
session preset in the pi SDK — hermetic resources, in-memory session
state, and a first-class "final tool" or forced-tool-choice option — so a
read-only judge (or any bounded evaluator) does not rebuild policy that
belongs in the driver.

## 6. Budget enforcement — observing your own spend

Logged by the judge extension (plan pl-17ca step 6, warren-33da).

- `[worked around]` **No usage or cost surface for an observer.**
  `JUDGE_DAILY_BUDGET_USD` is a fleet-wide gate the judge must enforce
  on itself, but warren exposes no endpoint an extension can read its
  own accrued spend back from — `GET /runs/:id` reports the JUDGED
  run's cost, never the observer's. The judge therefore keeps its own
  durable spend ledger in extension-owned SQLite
  (`extensions/judge/src/spend-ledger.ts`), summed per UTC day. Cost:
  the budget is only as accurate as the extension's own bookkeeping —
  a second judge replica pointed at the same warren with a separate
  database gets its own independent "fleet" budget, so the gate is
  per-deployment-of-the-extension, not truly fleet-wide.
- `[worked around]` **No "became terminal since" discovery feed.** The
  judge's discovery gate is "run is in a terminal state," but `GET
  /runs` has no `?state=` filter and no transition timestamp to
  incremental-sync against, so every poll cycle re-lists the full
  history and filters client-side (§1's moving-desc-page caveat
  applies verbatim). The per-run judgment cursor absorbs the re-seen
  rows; the cost is O(all runs ever) list traffic per cycle, growing
  forever.

**What the future mechanism must provide:** a read-only usage surface
(`GET /usage?since=`) that any token holder can scope to itself, and a
`?state=terminal&since=<ts>` filter on `GET /runs`, so a bounded
observer can enforce a fleet budget against server truth and
incremental-sync terminal transitions instead of re-listing history.
