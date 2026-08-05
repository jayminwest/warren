# Extensions — kinds, packaging, and the road to a public catalog

**Status:** Provisional — a direction record, not a spec. This document
names the vocabulary and the sequencing for warren's extension
ecosystem. It deliberately does **not** design the manifest, the
loader, or the delivery mechanism. ROADMAP Next item 6 forbids that
design on speculation: the flagship extension build (plan **pl-116e**)
produces the friction report those specs get written from. Every
section below that sketches a mechanism is marked provisional and
yields to what the build teaches.
**Grounds:** [`PHILOSOPHY.md`](../PHILOSOPHY.md) "Extension tiers" +
rules 2, 5, and 6;
[`tier1-observation-bus.md`](tier1-observation-bus.md) (the live
`warren-ext/v1` bus); ROADMAP "Deliberately not in core" (the extension
catalog-in-waiting).

---

## 0. What this cuts

The Tier-1 bus is live, observe-only, and versioned — but every
consumer today is compiled into
`src/server/main/lifecycle-bus-wiring.ts` and rebuilt with the server.
There is no loader, no package format, no process boundary, and no
place a third party can publish to. This record fixes the shared
vocabulary for closing those gaps, so the flagship build, the roadmap,
and the public site tell one story while the actual contracts stay
unfrozen.

## 1. Two extension kinds

Warren extensions split into two kinds with different data flow. The
tiers in PHILOSOPHY (Tier 0 skills / Tier 1 containers / Tier 2
operator hooks) answer *where code runs and who trusts it*. The kinds
answer *which way the calls point*.

### Observers (shipping first)

An observer consumes the run lifecycle and never participates in it.
Warren pushes facts outward; the observer can be slow, absent, or
broken without touching a run. The audit log, notification sinks
(Slack, Sentry, Grafana), activity feeds, metrics exporters, and spend
dashboards are all observers — the entire "Deliberately not in core"
catalog reads as this kind.

Observers need no new core surface to exist today. PHILOSOPHY rule 5
(data formats are API) means the HTTP API, the events table, and the
JSONL/NDJSON streams are already a delivery mechanism — a clunky one,
and documenting exactly *how* clunky is a deliverable of the flagship
build. The in-process bus (`warren-ext/v1`) is the semantic model an
eventual out-of-process delivery mechanism will mirror.

### Providers (direction only — not yet committed)

A provider implements a warren-defined contract that warren *calls*
and waits on: fetch an issue, close an issue, open a PR. Today every
provider seam (`RuntimeProvider`, `AuthProvider`, the planned `Forge`
and `IssueTracker`) is an in-process TypeScript implementation
selected at boot.

The direction under evaluation: let providers live out-of-process too,
behind a **bridge implementation** — one in-core adapter per seam that
speaks a versioned wire protocol (for example `warren-tracker/v1`) to
an external container. The seam keeps its TypeScript contract and its
two-implementation rule; the bridge is simply one of the
implementations, and every external provider walks through it. Prior
art: Concourse resource types, Drone/Woodpecker plugins.

This kind is **not committed**. It would amend ROADMAP Next item 3
(Linear moves from in-core implementation #2 to first external tracker
extension), and that amendment is an owner decision that has not been
recorded. A wire protocol is a far heavier promise than a TypeScript
interface — PHILOSOPHY rule 6 names API churn as the ecosystem-killer
— so no provider wire contract stabilizes before at least two real
external implementations exist against it.

## 2. The flagship observer: the audit log (pl-116e)

The first public extension is the audit log (old R-16, amended
2026-08-03 so actor *kind* suffices for attribution). Chosen over
every alternative because it has zero external dependencies, tests
deterministically, and is maximally demanding on delivery guarantees —
an audit log that drops events is worthless, so it forces the
durability, cursor, and catch-up questions the delivery mechanism must
eventually answer.

Shape of v0:

- Lives at `extensions/audit-log/` as a standalone Bun package — own
  lockfile, own tests, own container image, buildable from its
  directory alone.
- Consumes warren's **existing** HTTP surfaces (runs list + per-run
  event tails) with a durable cursor and at-least-once semantics;
  normalizes into an append-only store with idempotent apply; exports
  `GET /audit-log.jsonl?since=` plus `/healthz`.
- Zero audit-specific lines in warren core. The only core diffs are
  generic: the `check:layers` walk covers `extensions/`, two layer
  rules forbid imports across the boundary in both directions, and
  root gates exclude the tree.
- `FRICTION.md` in the extension is the primary design artifact: every
  place the HTTP-tail approach hurts (hand-derived wire types, missing
  actor attribution, per-run tail fan-out, restart catch-up) becomes a
  named requirement on the future mechanism.

Success criterion, in the seam-test style: a third party could have
built this without reading warren's source — and everywhere that is
false today is written down as friction.

**Status: shipped (2026-08-05).** All six plan steps landed; the
extension collects, survives a mid-stream kill without loss or
duplication, and exports byte-identical to its committed golden
(`extensions/audit-log/src/smoke.test.ts`). The finalized friction
report is [`extensions/audit-log/FRICTION.md`](../../extensions/audit-log/FRICTION.md)
— it is the input the manifest, loader, and delivery-mechanism specs
now get written from (§5).

## 3. Packaging conventions (provisional)

The Woodpecker-model sketch from PHILOSOPHY, held as direction until
the friction report confirms or corrects it:

- **Unit of distribution:** a container image, versioned by tag.
- **Configuration:** environment variables only. Today that is
  `WARREN_BASE_URL` + `WARREN_API_TOKEN` plus extension-owned knobs;
  the aspirational contract is a `PLUGIN_*` namespace warren injects
  at a lifecycle stage.
- **State:** an extension owns its storage (its own volume, its own
  database). Extension data never lands in a warren table.
- **Manifest:** each extension ships a small declaration — name,
  kind, hooks or contract consumed, protocol version, image ref,
  config schema. The exact format is **not designed here**; it is the
  chief output expected from the pl-116e friction report, and it is
  the same artifact both the future loader and the site catalog read.

## 4. Distribution: the public catalog

warren-site gains an `/extensions` page (the pi.dev/packages shape): a
browsable catalog where each entry names what the extension does, what
it consumes, and where its image lives. Mechanics, cheapest first:

1. **Curated allowlist** — a JSON file in the warren-site repo,
   accepting PRs. Zero crawl infrastructure, spam-proof, converts
   later.
2. **Discovery by convention** — a GitHub topic
   (`warren-extension`) crawled at site build time, once volume
   justifies it.

The site page ships alongside the flagship so the catalog exists the
day the first entry does.

## 5. Open questions (reserved, in rough order of arrival)

- **Delivery mechanism** — polling the HTTP API vs a global lifecycle
  stream endpoint (warren-f566 wants the same stream for the UI) vs
  per-hook container invocation. Decided by the friction report, not
  here.
- **Actor attribution** — lifecycle payloads carry no actor kind yet;
  additive `warren-ext/v1` field, ties to warren-3754.
- **Admin-action hooks** — project added/deleted, agent edits, auth
  events are not on the bus; add them when the first consumer needs
  them (the audit log's reserved list is the queue).
- **Provider wire protocols** — the §1 bridge direction, gated on an
  owner decision and a roadmap amendment; trackers (Linear, Jira,
  GitLab) are the first candidate family.
- **Forge extensions** — the same bridge logic applied to forges cuts
  deeper (PR-opening sits directly behind the kernel's push); parked.
- **Tier-2 mutating hooks** — deferred until paid, unchanged; the
  likely first payer is a policy gate that must reject before
  dispatch.
