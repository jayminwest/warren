# `.warren/` Directory Convention + Config-Loader Contract

> **Salvage provenance:** lifted from the retired top-level spec §11.H (`.warren/`
> directory convention, 2026-05-10, reorg 2026-05-14) as part of the
> SPEC retirement plan `pl-1717` (step `warren-3bec`). The wording
> below is the live contract — `src/warren-config/load.ts`, doctor
> checks, and acceptance scenario 14 assert against it — so edit it
> only in lockstep with the code it describes. Cross-references to
> other SPEC sections (§11.L, §11.I, …) are repointed by the later
> sweep steps of `pl-1717`.

## `.warren/` directory convention (2026-05-10, reorg 2026-05-14)

R-02 from `ROADMAP.md` shipped via plan `pl-5d74` (warren-571f) before the
V2 phase opens. Worth pinning in V1's frozen record because the warren ↔
project-repo seam now has a third tier alongside `.canopy/` (prompts) and
`.mulch/` (expertise). The `.warren/` YAML reorg (warren-5840) lands as a
follow-up under pl-2c59; this section captures the post-reorg layout with
the legacy file documented as the loader fallback.

**Layout (warren-5840).** Each project repo may contain a `.warren/`
directory with these optional files:

```
.warren/
  triggers.yaml      # array of trigger entries (cron today; webhooks future)
  config.yaml        # per-project default role / branch / prompt / runBranchPrefix
  preview.yaml       # per-run preview environment (R-19 / §11.L) — top-level
                     # document is the preview block itself
  pr-template.md     # per-fragment PR-body overrides (warren-bd49)
  defaults.json      # DEPRECATED: legacy JSON home for everything in
                     # config.yaml / preview.yaml; loader still reads it
                     # and emits a deprecation warning (warren-5840)
```

All files are optional; the loader's envelope returns `null` for missing
files instead of erroring (`mx-66d478`), so existing project repos keep
working unchanged.

**Format choice.** YAML across the board (warren-5840) so comments are
allowed (JSON's biggest weakness) and arrays-of-objects stay readable as
new blocks accumulate. The pre-reorg JSON choice (`mx-2cefdd`) is
superseded by the warren-5840 decision; both formats keep working until
projects migrate via `warren config migrate`. YAML parser is `js-yaml
^5.x` (was `^4.1.1`; warren-381c) to match mulch + overstory (`mx-8b6896`).

**Schema.** `triggers.yaml` is `Array<Trigger>` with a `kind:` discriminator
(only `'cron'` is implemented today; `kind:` exists so future webhook
entries can land without a breaking schema rev — `mx-3636de`). Cron-token
validation is intentionally loose (5 or 6 whitespace-separated fields,
non-empty); R-06 owns full grammar checking when it wires in croner
(`mx-40fe51`). A cron entry may also carry an optional `maxCostUsd`
(warren-a63d) — a positive USD spend cap. At dispatch warren folds it
onto the agent's frontmatter (overriding the agent's own
`frontmatter.maxCostUsd`, so trigger > agent), freezing a single
effective cap onto `runs.rendered_agent_json`; the event-bridge cancels
the run once cumulative cost crosses it (emitting a `budget.exceeded`
event). A malformed / non-positive value fails OPEN (no cap) so a budget
typo never silently cancels every run. `config.yaml` and legacy
`defaults.json` share the same
schema — `{ defaultRole?, defaultBranch?, defaultPrompt?, defaultProvider?,
defaultModel?, runBranchPrefix?, preview?, maxCostUsd? }` — all optional,
all strict. `maxCostUsd` on `config.yaml` is the project-wide default
spend cap, the weakest source in the warren-a63d chain: an explicit
dispatch override (a `POST /runs` `maxCostUsd` body field / `warren run
--max-cost-usd`, or a trigger entry's cap) > the agent's own
`frontmatter.maxCostUsd` > this project default. The default applies only
when the agent declares no cap at all — a malformed / non-positive agent
value keeps the fail-open rule above (no cap, and the unreadable value
stays visible on the frozen `rendered_agent_json`) rather than being
silently replaced by the project default. `resolveCapOverride` in
`src/runs/cost-cap.ts` is the one implementation of this chain.
`runBranchPrefix` (warren-9993) overrides the prefix warren composes the
burrow branch from (`${prefix}/${run.id}`); precedence project default >
`WARREN_RUN_BRANCH_PREFIX` env > built-in `"burrow"`. `preview.yaml` (when
present) carries the preview block at the top level and wins over any
nested `preview:` field — see `PreviewConfigSchema` in §11.L.

**Loader contract** (`src/warren-config/load.ts`):

- Returns `LoadedWarrenConfig = { triggers: TriggersConfig | null,
  defaults: DefaultsConfig | null, prTemplate: PrTemplateOverrides | null,
  errors: WarrenConfigFileError[], warnings: WarrenConfigFileError[] }`.
- Missing file → entry is `null`, no error.
- Present-but-malformed file → entry is `null`, error appended with code
  (`warren_config_parse_error | warren_config_schema_error`) and message.
- `pr-template.md` (warren-bd49) is loaded the same way: missing → `null`;
  unknown fragment names / unbalanced preview markers surface as
  `schemaError` entries that flow through doctor + readyz.
- **Defaults precedence (warren-5840):** `.warren/config.yaml` >
  `.warren/defaults.json` (legacy). When the legacy file is present the
  loader appends a `warnings[]` entry with code `warren_config_deprecated`
  pointing at `warren config migrate`; this never flips `errors[]`.
- **Preview precedence (warren-5840):** `.warren/preview.yaml` > nested
  `preview:` field on the resolved defaults envelope. The loader merges
  `preview.yaml` into `defaults.preview` so downstream consumers keep
  reading `defaults?.preview` regardless of which file the value came from.
- Per-project cache (`src/warren-config/cache.ts`) is invalidated inside
  `refreshProject` and `deleteProject` (`mx-61c0e6`) so the next request
  reparses; this avoids the stale-config race called out in pl-5d74 risk #4.

**Fail-closed dispatch (warren-02aa).** The loader contract above is
read-only: it never throws and never guesses a partial value. Consumers
that merely RENDER config (doctor, `/readyz`, the UI) keep reading
`defaults: null` plus `errors[]`. Consumers that ACT on guardrails must
not. `DefaultsConfigSchema` is `.strict()`, so one unknown key (e.g.
`admission.maxConcurrentRun`, missing the `s`) rejects the whole document
— and every guardrail it carried (admission cap, quality gate, resource
limits, cost caps) used to disappear at once while the dispatch went
through uncapped.

`readProjectDefaults` (`src/runs/spawn/agent-cache.ts`) now calls
`assertGuardrailConfigUsable` and throws `WarrenConfigInvalidError`
(HTTP 422) when an `errors[]` entry names a guardrail-bearing file —
`.warren/config.yaml` or the legacy `.warren/defaults.json`. The refusal
lands before the run row is created, so a broken policy file produces no
orphan run. `triggers.yaml` and `pr-template.md` are deliberately outside
that set: neither constrains what a dispatched run may do, so they keep
degrading gracefully. A project with NO config file at all is unchanged —
no errors, built-in defaults, dispatch proceeds.

Whole-document strictness is kept rather than salvaging section by
section. Per-section validation would still drop precisely the knob the
operator fat-fingered, which is the same bug with a smaller blast radius.
Strict parse plus a dispatch-blocking failure is the only shape where a
typo cannot widen a guardrail.

**HTTP surface.** `GET /projects/:id/warren-config` returns the
`LoadedWarrenConfig` envelope verbatim (`mx-adf588`); 404 if the project
doesn't exist; `WarrenConfigUnavailableError` joins the existing
`BurrowUnreachableError` / `CanopyUnavailableError` /
`ProjectUnavailableError` family (`mx-bd1f9f`).

**UI surface.** Project detail (`src/ui/src/pages/ProjectDetail.tsx`,
`mx-dc191e`) renders three blocks per envelope: triggers list, defaults
key/value, per-file errors. Read-only in V1 — editing the YAML/JSON is a
git operation; warren only surfaces the parsed view (`mx-a5e30e`).

**Diagnostics.** `warren doctor` and `/readyz` emit two .warren/ checks:

- `warren_config` aggregates fatal `errors[]` (parse / schema) into a
  single failing-on-any-error row (`mx-f37c30`).
- `warren_config_deprecations` (warren-5840) aggregates non-fatal
  `warnings[]` — today only the `defaults.json` deprecation — and stays
  `ok: true` regardless so a legacy install doesn't flip doctor red.
  The check's hint names the one-shot fix: `warren config migrate`.

Doctor's check ordering now includes both rows; existing acceptance
scenarios continue to look for `warren_config` specifically.

**Acceptance.** Scenario 14 (`scripts/acceptance/scenarios/14-warren-config.ts`)
exercises absent / valid / malformed against `/readyz` rather than spawning
`warren doctor` as a child, because doctor would be running against the
wrong DB (`mx-e959c0` documents the rationale).

**Scope deliberately deferred to R-04.** `defaults.defaultRole` is
parsed but spawn still falls back to `WARREN_DEFAULT_AGENT`;
`defaults.defaultPrompt` has no template-substitution consumer yet. As of
2026-05-11 the trigger half is no longer deferred — R-06 (§11.I) dispatches
`triggers.yaml` entries on a 60s tick.
