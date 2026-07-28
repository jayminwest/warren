# Warren Project Philosophy

**Warren ships minimal but incredibly extensible.** The aspiration, stated
plainly: be the [pi.dev](https://pi.dev/) of software factories — a small,
legible orchestration kernel where every noun is a provider behind a
contract and every feature is an extension the core doesn't know about.

This is not a rewrite or a refactor project. It is an operating policy:
from here on, every feature gets built behind a seam instead of into the
core, and existing features migrate behind seams as roadmap work touches
them.

## What pi.dev proves

Pi's reputation rests on disciplined subtraction plus total
interceptability: a tiny core (four tools, a ~300-word prompt), hooks at
every lifecycle boundary, and a **features-as-extensions discipline** —
the maintainers deliberately left sub-agents, plan mode, and sandboxing
out of core, then shipped each one as an extension to prove the extension
API could carry real weight. "Adapt Pi to your workflows, not the other
way around."

Warren's translation: the core is the run loop; the value proposition is
the contracts.

## The kernel

The irreducible core is:

> **project registry → dispatch → sandboxed run → event stream →
> steer/pause → reap → push branch**

plus the HTTP API, the UI shell, and storage. That's it.

A control plane necessarily carries more state than a CLI — runs,
projects, events, auth — so "minimal" here means *minimal surface, few
nouns*, not few lines. The kernel's guaranteed output is a pushed
workspace branch; everything past that point (opening a PR, closing an
issue, syncing a plot) is extension behavior.

The litmus test for whether something belongs in core:

> If it can be expressed as "something that observes or reacts to the run
> lifecycle," it is an extension.

By that test, plan-runs, mulch, seeds integration, healer, ci-fixer,
preview environments, and triggers are all extensions-in-waiting.
Removing a feature should mean *not loading it*, never surgery.

**Amendment (2026-07-17):** plot, conversations (brainstorming/chat),
and canopy fail a *prior* test — they have no users. They are being
**deleted outright**, not re-platformed (rule 8). A deleted feature can
return as an extension when someone wants it badly enough to pay for
the API it needs.

## The seams

Every swappable noun gets a contract, a registry, and at least two
implementations. Current state:

| Seam | Contract | Status |
|------|----------|--------|
| Runtime / sandbox | `RuntimeProvider` (`src/runtime/contract.ts`) | **Live** — local (burrow) + k8s. Eviction of legacy direct burrow paths tracked in pl-829f. |
| Storage | dialect-aware db layer (`src/db/client.ts`) | **Live** — sqlite + postgres. |
| Forge (GitHub, …) | `Forge` — openPR, mergePR, checkRuns, repo URLs, auth | Planned; cut alongside the GitHub App work. |
| Issue tracker | `IssueTracker` — seeds first, Linear/GitHub Issues second; capability-flagged (`supportsPlans`) so plan-runs degrade gracefully on trackers without plan shapes | Planned; cut alongside the Linear integration. |
| Auth | `AuthProvider` — `token` (bearer, today's default) + `github` (GitHub App login, repo-permission mirroring) | Planned; cut alongside the GitHub App / teams work. |
| Agent runtime | `AgentRuntimeAdapter` — command construction, event parsing, steering format, per runtime | Planned. Lives in **warren**, not burrow; burrow stays a dumb sandbox primitive. |
| Extensions | lifecycle event bus + registration API | Tier-1 observe bus + registration API landed (`src/runs/lifecycle-bus.ts`, warren-bb60; [design](design/tier1-observation-bus.md)), with the run-lifecycle emit call-sites wired and the healer registered as proof consumer #1 (warren-4e74, `src/healer/lifecycle.ts`). Fully **Live** once the mirror eviction lands too (warren-df3e). Tier 1 (observe) before Tier 2 (participate). |

The `RuntimeProvider` contract and the storage dialect layer are the
house style for every future seam: provider-neutral DTOs, capability
flags, env/config-selected registry resolved once at boot, unknown
selections fail loudly.

## Extension tiers

Who wrote the code determines which mechanism carries it. Three tiers,
split by trust, cheapest first — and the first tier is always the first
answer to "where does my custom integration code live":

- **Tier 0 — in-repo skills.** Most "integrations" need no warren
  surface at all: CLI tools plus a README/AGENTS.md in the *project's
  own repo*, invoked by the agent inside the sandbox, paid for only
  when used. A team's AWS/S3/deploy tooling lives here first.
- **Tier 1 — container plugins.** Run-adjacent custom code is a
  container with an env contract (the Woodpecker CI model): warren
  invokes the team's image at a lifecycle stage with `WARREN_RUN_ID` /
  `PLUGIN_*` env vars. A custom harness is just an agent image plus a
  registry entry. Language-agnostic; versioned by image tag; survives
  core churn.
- **Tier 2 — operator hooks.** In-process TypeScript loaded at boot
  from deployment config, for the person who *owns* the deployment
  only. Third-party code never runs inside the server process.

The hook contract is versioned from day one (`warren-ext/v1` in every
payload, negotiated at handshake, Terraform-style), and breaking
changes deprecate into a compat shim before removal. Every refusal to
add a feature to core gets a public "deliberately not in core" entry
with a recipe pointing at the tier that carries it.

## Operating rules

1. **Features pay for seams.** Never cut an abstraction speculatively;
   cut it when a second implementation forces it. The k8s migration paid
   for `RuntimeProvider`; the GitHub App pays for `Forge`; Linear pays
   for `IssueTracker`. Building the feature *without* cutting the seam
   first deepens coupling that must then be un-deepened — order matters.
2. **First-party features must be expressible as extensions.** If
   plan-runs or mulch can't be rebuilt on the extension API, the API
   isn't good enough yet. We eat our own constraint, like pi shipping
   sub-agents as an extension.
3. **`ServerDeps` only shrinks.** The dep bag is the anti-pattern this
   policy exists to kill. New capabilities register through a seam; they
   do not add fields. (Twelve plot-specific injector fields is the
   cautionary tale.)
4. **A seam isn't done until it's enforced.** Definition of done for any
   eviction is a lint/check gate that fails on a boundary-violating
   import — not a clean grep on one day.
5. **Data formats are API.** The JSONL run-event stream, the events
   table, the OpenAPI surface — machine-readable at every boundary.
   Out-of-process integrations build on these before any in-process
   plugin API exists.
6. **Extension API is versioned from day one, and read-only as long as
   possible.** Warren extensions will be load-bearing in other people's
   deployments; API churn is the failure mode that kills server-side
   plugin ecosystems. Observation hooks (run dispatched / event / reaped
   / branch pushed) come first; mutating hooks only when a real extension
   needs them.
7. **Capabilities, not conditionals.** Runtime- or integration-specific
   behavior gates on declared capability flags (`RuntimeCapabilities`),
   not on `hasPlot`-style booleans scattered through handlers.
8. **Unused features are deleted, not re-platformed.** Rule 2 applies
   to features that earn their keep. A feature with no users can't pay
   for a seam (rule 1), so building extension API to carry it is
   speculative abstraction wearing a discipline costume. Delete it and
   keep the door open — deletion is the honest form of subtraction, and
   pi's minimalism began with leaving things out, not carrying them.

## Anti-goals

Things warren deliberately does not build into core, and the prescribed
escape hatch:

- **No bundled workflow opinions** — plot/intent, chat, plan orchestration
  are extensions you can decline to load, not core you rip out.
- **No forge monoculture** — GitHub is implementation #1 of `Forge`, not
  an assumption. The kernel's contract with the world is a pushed branch.
- **No issue-tracker monoculture** — seeds is implementation #1 of
  `IssueTracker`, not a structural dependency.
- **No agent-runtime semantics in the sandbox layer** — burrow runs a
  command and streams output; what a claude-code vs. pi event *means* is
  warren's adapter's job.
- **No in-core integration sprawl** — Slack, Linear, Sentry, Grafana
  arrive as extensions on the event bus, never as new `ServerDeps`
  fields.

## Sequencing

Standing order of work, each step paid for by a roadmap item
(amended 2026-07-17):

1. **Burrow-client eviction** (pl-829f, warren-36cb…warren-f796) —
   effectively landed: `ServerDeps.burrowClient` is gone and spawn/reap
   route through `RuntimeProvider`. Close out the remaining pl-829f
   children and the boundary lint.
2. **Deletion pass** (pl-3a79, warren-e7e7…warren-0515) —
   conversations → plot (+ plot-plan-run bridges)
   → canopy, in that order (conversations depend on plot; plan-runs'
   plot hooks leave with plot). Includes pulling the plot merge out of
   `RuntimeProvider.finalize()` and deleting the twelve plot injector
   fields — `ServerDeps` shrinks by ~15 fields in one stroke.
3. **Tier-1 event bus** (pl-3a79 steps 16–18,
   warren-bb60/warren-4e74/warren-df3e) on `RunEventBroker`, proven by
   moving healer
   onto it and evicting the mulch/seeds mirrors from `finalize()` —
   the finalize contract stops enumerating features.
4. **`Forge` + `AuthProvider` contracts**, both paid for by the GitHub
   App (teams: login, repo-permission mirroring, `run.dispatched_by`
   attribution).
5. **`IssueTracker` contract**, paid for by Linear or GitHub Issues —
   capability-flagged so plan-runs degrade gracefully on trackers
   without seeds-style plan shapes.
6. **Re-platform plan-runs / mulch / seeds as extensions** — where
   `ServerDeps` finishes dying and "remove a feature" becomes "don't
   load it."
7. **`AgentRuntimeAdapter`** — pulls runtime string interpretation and
   payload parsing (`terminal-detect.ts`) behind a warren-owned registry.

Warren becomes the pi.dev of software factories by accretion of
discipline — which is also how pi did it.
