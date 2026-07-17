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

By that test, plan-runs, plot, mulch, canopy, seeds integration, healer,
ci-fixer, preview environments, triggers, and conversations are all
extensions. Removing a feature should mean *not loading it*, never
surgery.

## The seams

Every swappable noun gets a contract, a registry, and at least two
implementations. Current state:

| Seam | Contract | Status |
|------|----------|--------|
| Runtime / sandbox | `RuntimeProvider` (`src/runtime/contract.ts`) | **Live** — local (burrow) + k8s. Eviction of legacy direct burrow paths tracked in pl-829f. |
| Storage | dialect-aware db layer (`src/db/client.ts`) | **Live** — sqlite + postgres. |
| Forge (GitHub, …) | `Forge` — openPR, mergePR, checkRuns, repo URLs, auth | Planned; cut alongside the GitHub App work. |
| Issue tracker | `IssueTracker` — seeds first, Linear second | Planned; cut alongside the Linear integration. |
| Agent runtime | `AgentRuntimeAdapter` — command construction, event parsing, steering format, per runtime | Planned. Lives in **warren**, not burrow; burrow stays a dumb sandbox primitive. |
| Extensions | lifecycle event bus + registration API | Planned. Tier 1 (observe) before Tier 2 (participate). |

The `RuntimeProvider` contract and the storage dialect layer are the
house style for every future seam: provider-neutral DTOs, capability
flags, env/config-selected registry resolved once at boot, unknown
selections fail loudly.

## Operating rules

1. **Features pay for seams.** Never cut an abstraction speculatively;
   cut it when a second implementation forces it. The k8s migration paid
   for `RuntimeProvider`; the GitHub App pays for `Forge`; Linear pays
   for `IssueTracker`. Building the feature *without* cutting the seam
   first deepens coupling that must then be un-deepened — order matters.
2. **First-party features must be expressible as extensions.** If plot
   or plan-runs can't be rebuilt on the extension API, the API isn't good
   enough yet. We eat our own constraint, like pi shipping sub-agents as
   an extension.
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

Standing order of work, each step paid for by a roadmap item:

1. **Burrow-client eviction** (pl-829f, warren-36cb…warren-f796) —
   finish the `RuntimeProvider` decision; `ServerDeps.burrowClient`
   deleted and the boundary lint-enforced.
2. **Tier-1 event bus**, proven by moving one reactive feature (healer)
   onto it.
3. **`Forge` contract**, paid for by the GitHub App.
4. **`IssueTracker` contract**, paid for by Linear.
5. **Re-platform plot / mulch / canopy / plan-runs as extensions** —
   where `ServerDeps` actually dies and "remove chat" becomes "don't
   load it."
6. **`AgentRuntimeAdapter`** — pulls runtime string interpretation and
   payload parsing (`terminal-detect.ts`) behind a warren-owned registry.

Warren becomes the pi.dev of software factories by accretion of
discipline — which is also how pi did it.
