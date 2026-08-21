# Tier-1 Observation Event Bus — `warren-ext/v1`

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-07-28
**Shipped:** v0.13.0
**Current truth:** `src/runs/lifecycle-bus.ts` and `src/server/main/lifecycle-bus-wiring.ts`

The observe-only lifecycle seam (warren-bb60,
pl-3a79 step 16) with its first proof consumer wired (warren-4e74,
step 17). The bus + registration API ship in `src/runs/lifecycle-bus.ts`;
the run-lifecycle emit call-sites (`run_dispatched` in `spawnRun`,
`run_started` + `event_emitted` in the event bridge (warren-28ca),
`pre_reap` / `post_reap` / `branch_pushed` in `reapRun`) publish through
the boot-installed process singleton, and the healer
(`src/healer/lifecycle.ts`) is registered as proof consumer #1 via
`registerExtensions`. warren-df3e (mulch/seeds mirror eviction) evicts
the finalize-enumerated mirrors onto `post_reap` next.
**Grounds:** [`PHILOSOPHY.md`](../PHILOSOPHY.md) "Extension tiers" +
operating rule 6 ("read-only as long as possible"); layered on the
existing `RunEventBroker` (`src/runs/events.ts`).

---

## 0. What this cuts

Warren's first-party features (the healer, the mulch mirror, the seeds
close) are wired today as bespoke boot plumbing or enumerated inside
`RuntimeProvider.finalize()`. PHILOSOPHY rule 2 says a first-party
feature that can't be rebuilt on the extension API means the API isn't
good enough yet, and rule 3 says `ServerDeps` only shrinks. This bus is
the seam those features migrate onto: a boot-wired consumer
**observes** the run lifecycle instead of being special-cased into it.

This is **Tier 1 (observe)**. There are no mutating / participate hooks
— a subscriber cannot veto a dispatch, mutate a payload, or stall the
run loop. Mutating hooks wait for a real extension that needs them
(rule 6).

## 1. Hook taxonomy

Ordered along a run's life. All observe-only.

| Hook | Fired when | Payload |
| --- | --- | --- |
| `run_dispatched` | `provider.create` returned a handle; the warren row has correlation ids | `RunDispatchedPayload` |
| `run_started` | the run left `queued` for `running` | `RunStartedPayload` |
| `event_emitted` | one run-event row landed + published to the broker | `EventEmittedPayload` |
| `pre_reap` | reap is about to run, before finalize touches the workspace | `PreReapPayload` |
| `post_reap` | the reap pipeline finished (mirror counts, push result) | `PostReapPayload` |
| `branch_pushed` | the workspace branch reached origin | `BranchPushedPayload` |

Payloads are provider-neutral DTOs (`src/runs/lifecycle-bus.ts`) — no
burrow id, pod name, socket, or host path crosses the seam beyond the
neutral `sandboxId` / `providerRunId` correlation strings.

## 2. Versioned from day one

Every envelope carries `protocol: "warren-ext/v1"`
(`WARREN_EXT_PROTOCOL`), stamped by the bus at emit time along with an
ISO `at`. Registration is a handshake: an extension declares the
protocol it was built against and `LifecycleBus.register` throws on a
mismatch. A future `warren-ext/v2` ships a compat shim rather than
silently feeding v2 envelopes to a v1 consumer.

## 3. Registration API

```ts
const bus = new LifecycleBus({ onError, now });

const reg = bus.register({
  name: "healer",
  protocol: WARREN_EXT_PROTOCOL,
  hooks: {
    post_reap: (env) => { /* observe env.payload */ },
  },
});
// ...later
reg.unregister();
```

- An extension names exactly the hooks it subscribes to; each named
  hook is its declared capability (capabilities, not conditionals —
  rule 7).
- Registration rejects a protocol mismatch, an empty subscription, and
  an unknown hook name.
- `registerExtensions(bus, [...])` is the boot convenience: register a
  batch, get one `unregisterAll()` back. This is the single path the
  survivors of the deletion pass (pause detector, watchdog, ops-stats)
  and the follow-up consumers (healer, mirrors) wire through — no
  bespoke per-consumer plumbing, no `ServerDeps` field.
- `installLifecycleBus(bus)` / `lifecycleBus()` is the boot-installed
  process singleton the run-lifecycle emit call-sites publish through,
  so a consumer wires ONCE at boot instead of threading the bus down
  `spawnRun` / `reapRun` (again, no `ServerDeps` field — rule 3). Unset
  (unit tests) ⇒ `lifecycleBus()` is `undefined` and every emit is a
  no-op, so instrumentation never changes control flow.

`src/server/main/lifecycle-bus-wiring.ts` is where boot constructs the
bus (error sink → the boot logger), registers the first-party consumers,
and installs the singleton; its `stop()` unwinds both on teardown.

## 4. Observe-only isolation

`emit` deep-freezes the envelope and its payload before handing it to a
subscriber, so a handler can't mutate what the emitter does next. A
handler's return value is ignored; a thrown error (sync) or a rejected
promise (async) is caught and routed to the bus `onError` sink, never
rethrown at the emit call-site. Async handlers run detached — a slow
subscriber cannot stall the run loop.

## 5. Relationship to `RunEventBroker`

The broker (`src/runs/events.ts`) fans a run's **event rows** out to
live HTTP tailers; this bus fans the **run lifecycle** out to boot-wired
consumers. The `event_emitted` hook is the lifecycle mirror of a broker
`publish` — the bridge is the call-site for both. `run_started` fires
from the bridge's atomic queued → running claim (`claimById`) and
`event_emitted` fires immediately after each `broker.publish`, so both
hooks emit on the real production run path (warren-28ca). The bus holds
nothing durable; like the broker, the events table remains the recovery
boundary.
