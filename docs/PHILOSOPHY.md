# Warren Project Philosophy

**Warren ships minimal but extensible.** The aspiration, stated
plainly: be the [pi.dev](https://pi.dev/) of software factories — a
small, legible orchestration kernel where every noun is a provider
behind a contract, and every feature is an extension the core does not
know about.

This document holds policy only. It contains the rules that stay true
for years. For direction, sequencing, and the status of each seam, read
[ROADMAP.md](../ROADMAP.md). For the work queue, run `sd ready`. If a
sentence here names the current state of the code, that sentence is a
bug in this document.

## What pi.dev proves

Pi's reputation rests on disciplined subtraction plus total
interceptability: a tiny core, hooks at every lifecycle boundary, and a
features-as-extensions discipline. The maintainers left sub-agents,
plan mode, and sandboxing out of core. Then they shipped each one as an
extension to prove that the extension API could carry real weight.
"Adapt Pi to your workflows, not the other way around."

Warren's translation: the core is the run loop. The value proposition
is the contracts.

## The kernel

The irreducible core is:

> **project registry → dispatch → sandboxed run → event stream →
> steer/pause → reap → push branch**

plus the HTTP API, the UI shell, and storage. That is all.

A control plane carries more state than a CLI — runs, projects, events,
auth. So "minimal" here means *minimal surface, few nouns*, not few
lines. The kernel's guaranteed output is a pushed workspace branch.
Everything past that point — open a PR, close an issue, sync a tracker —
is extension behavior.

The litmus test for core membership:

> If a feature observes or reacts to the run lifecycle, it is an
> extension.

Removal of a feature must mean *not loading it*, never surgery.

## Seams

A seam is a swappable noun. Every seam gets a contract, a registry, and
at least two implementations. The house style, set by `RuntimeProvider`
and the storage dialect layer:

- Provider-neutral DTOs. A contract type never names a first-party
  feature.
- Capability flags, which the domain reads before it acts.
- One registry, selected by env or config, resolved once at boot.
- Unknown selections fail loudly at boot. No silent fallback.
- A falsification test, written before the contract: name the change
  that proves the seam failed.
- A lint gate that fails on a boundary-crossing import, landed in the
  same PR as the contract.

[ROADMAP.md](../ROADMAP.md) owns the list of seams, their status, and
the feature that pays for each one. Each cut seam gets a contract
document under `docs/design/`, modeled on
`docs/design/runtime-provider-contract.md`.

## Extension tiers

Who wrote the code determines which mechanism carries it. Three tiers,
split by trust, cheapest first. The first tier is always the first
answer to "where does my custom integration code live":

- **Tier 0 — in-repo skills.** Most integrations need no warren surface
  at all: CLI tools plus a README or AGENTS.md in the project's own
  repo, invoked by the agent inside the sandbox, paid for only when
  used. A team's AWS, S3, or deploy tooling lives here first.
- **Tier 1 — container plugins.** Run-adjacent custom code is a
  container with an env contract (the Woodpecker CI model). Warren
  invokes the team's image at a lifecycle stage with `WARREN_RUN_ID`
  and `PLUGIN_*` env vars. A custom harness is an agent image plus a
  registry entry. Language-agnostic, versioned by image tag, survives
  core churn.
- **Tier 2 — operator hooks.** In-process TypeScript, loaded at boot
  from deployment config, for the person who owns the deployment only.
  Third-party code never runs inside the server process.

The hook contract is versioned from day one (`warren-ext/v1` in every
payload, negotiated at handshake, Terraform-style). A breaking change
deprecates into a compat shim before removal. A declared hook that
never fires is a contract that lies. Emit it, or mark it reserved in
the design document and in the code.

Every refusal to add a feature to core gets a public "deliberately not
in core" entry in ROADMAP.md, with a recipe that names the tier that
carries it.

## Operating rules

1. **Features pay for seams.** Do not cut a seam on speculation. Cut it
   when a second implementation forces it. To build the feature without
   the seam deepens coupling that must then be un-deepened. Order
   matters.
2. **First-party features must be expressible as extensions.** If a
   first-party feature cannot be rebuilt on the extension API, the API
   is not good enough yet. We eat our own constraint, like pi shipping
   sub-agents as an extension.
3. **`ServerDeps` only shrinks.** The dep bag is the anti-pattern this
   policy exists to kill. A new capability registers through a seam. It
   does not add a field. (Twelve plot-specific injector fields is the
   cautionary tale.)
4. **A seam is not done until a gate enforces it.** The definition of
   done for any eviction is a lint or check gate that fails on a
   boundary-crossing import — not a clean grep on one day. The same
   standard applies to behavior claims: a capability parity that only a
   grep supports is not done either.
5. **Data formats are API.** The JSONL run-event stream, the events
   table, the OpenAPI surface — machine-readable at every boundary.
   Out-of-process integrations build on these before any in-process
   plugin API exists.
6. **The extension API is versioned from day one, and stays read-only
   as long as possible.** Warren extensions will be load-bearing in
   other people's deployments. API churn is the failure mode that kills
   server-side plugin ecosystems. Observation hooks come first.
   Mutating hooks come only when a real extension needs them.
7. **Capabilities, not conditionals.** Runtime-specific or
   integration-specific behavior gates on declared capability flags,
   not on `hasPlot`-style booleans scattered through handlers, and not
   on directory probes. A capability is declared by the provider and
   read by the domain.
8. **Unused features are deleted, not re-platformed.** Rule 2 applies
   to features that earn their keep. A feature with no users cannot pay
   for a seam (rule 1). To build extension API for it is speculation in
   a discipline costume. Delete it and keep the door open — a deleted
   feature can return as an extension when someone wants it enough to
   pay for the API it needs. Deletion is the honest form of
   subtraction. Pi's minimalism began with what it left out.

## Anti-goals

Things warren does not build into core, each with its escape hatch:

- **No bundled workflow opinions.** Plan orchestration and chat-shaped
  features are extensions you can decline to load, not core you rip
  out.
- **No forge monoculture.** The kernel's contract with the world is a
  pushed branch. GitHub is implementation #1 behind the `Forge` seam,
  never an assumption in domain code. Until the seam is cut, read this
  entry as a standard the code must reach — ROADMAP.md tracks the gap.
- **No issue-tracker monoculture.** Seeds is implementation #1 behind
  the `IssueTracker` seam, never a structural dependency. The same
  reading applies until the seam is cut.
- **No agent-runtime semantics in the sandbox layer.** Burrow runs a
  command and streams output. What a claude-code or pi event *means* is
  the job of warren's `AgentRuntimeAdapter`.
- **No in-core integration sprawl.** Slack, Sentry, and Grafana arrive
  as extensions on the event bus, never as new `ServerDeps` fields.
- **No multi-tenant SaaS.** One warren deploy serves one team. Seams
  declare a single-org scope explicitly.

## Where state lives

This file changes when the policy changes, and at no other time.

| Question | Source of truth |
|---|---|
| What is the policy? | This file |
| What is the direction and the order of work? | [ROADMAP.md](../ROADMAP.md) |
| What is the status of a seam? | ROADMAP.md seam table |
| What is the design of a cut seam? | `docs/design/*.md` |
| What work is open? | `sd ready` |
| What did we learn? | `ml prime` |

Warren becomes the pi.dev of software factories by accretion of
discipline — which is also how pi did it.
