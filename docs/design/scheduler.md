# Scheduler Contract (cron + scheduled-for)

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-08-01
**Shipped:** v0.1.6
**Current truth:** `src/triggers/`

> **Salvage provenance:** lifted from the retired top-level spec §11.I (Scheduler —
> cron + scheduled-for, 2026-05-11) as part of the SPEC retirement plan
> `pl-1717` (step `warren-979e`). The wording below is the live
> contract — `src/triggers/`, the `triggers` table migration, and
> acceptance scenario 15 assert against it — so edit it only in
> lockstep with the code it describes. Cross-references to other SPEC
> sections are repointed by the later sweep steps of `pl-1717`.

## Scheduler (cron + scheduled-for, 2026-05-11)

R-06 from `ROADMAP.md` shipped via plan `pl-2f15` (warren-3f59). The
scheduler is the only consumer of the trigger half of `.warren/` (see
`docs/design/warren-config.md`) and the warren-side consumer of seeds'
`extensions.scheduledFor` (seeds v0.4.3).

**Sources.** Two trigger kinds dispatch per tick:

- **Cron** — entries in `<projectPath>/.warren/triggers.yaml` with `kind: cron`
  and a cron expression. Warren-config parses the YAML (loose 5-or-6-token
  validation, `mx-40fe51`); the scheduler hands the expression to `croner`
  for the strict pass at fire time (`mx-5199d0`). Dispatched runs carry
  `trigger='cron'`.
- **Scheduled seeds** — `sd list --format json` against the project's
  `.seeds/` finds seeds whose `extensions.scheduledFor` (ISO-8601) is in
  the past. Dispatched runs carry `trigger='scheduled'`. The `trigger` column
  accepts arbitrary strings (`mx-513713`); current call-sites are `'manual'`
  (default and Run Now), `'cron'`, and `'scheduled'`.

**Tick.** One in-process loop, lives inside `bootServer`'s lifecycle. Cadence
via `WARREN_SCHEDULER_TICK_MS` (positive int, default 60000); disable with
`WARREN_SCHEDULER_DISABLED=1` (`mx-8e42e9`). The tick wraps itself in a
single-flight guard so a slow tick can't pile up — overlap is impossible,
worst case is reduced effective cadence rather than duplicated fires
(`mx-eb4a3a`). Acceptance harness compresses the cadence to 1s globally via
`scripts/acceptance/run.ts` extra-env (`mx-883866`). Teardown order on
shutdown is `handle.stop()` (HTTP listener) → `scheduler.stop()` →
`bridges.stopAll()` → burrow stop (`mx-15bd97`).

**Table shape.** Migration 0005 adds the `triggers` table. PK is a
composite string `'<projectId>:<triggerId>'` (`mx-55296f`), not a multi-column
key. `project_id` FK cascades on project delete; `last_run_id` FK is
`ON DELETE SET NULL` so reaping an old run never blocks the trigger row.
`TriggersRepo.upsert` uses undefined-vs-null semantics on patch fields:
omitted (`undefined`) preserves the existing value, explicit `null` clears
it (`mx-18a708`). First observation of a fresh trigger seeds
`lastFiredAt=now` and computes `nextFireAt = parsedCron.nextRun(now)`
(`mx-ac8acd`) — a fresh row never fires immediately, which is what gives the
"no catch-up after downtime" property.

**Failure semantics.**
- *Catch-up after warren downtime:* no. Cron is "fire at time T," not "fire
  N missed runs." Operators who want replay press Run Now.
- *Closed or missing referenced seed:* skip + structured log + surface as a
  `lastSkipReason` on the trigger summary in `GET /triggers`. Not a hard
  failure.
- *Cron parse failure on a YAML entry:* surfaced in the warren-config errors
  envelope on `GET /triggers` so operators see the failing entry without
  tailing logs. Other triggers in the same file continue to fire.
- *Project delete races with an in-flight tick:* per-project section of the
  tick is wrapped in try/catch; the FK cascade on `triggers.project_id`
  keeps the warren side consistent regardless.
- *Timezone / DST:* per-trigger `timezone` field is supported by croner.
  Default UTC when omitted. DST transitions in zoned triggers follow croner's
  semantics (skip the "lost" hour, fire once for the "repeated" hour) —
  document the chosen zone explicitly in `triggers.yaml`.

**Seeds write path.** When a scheduled seed fires, the write order is:
spawn run FIRST → if the spawn succeeds, attempt
`sd update <seed> --extensions '{"scheduledFor": null, "lastScheduledRun": "<iso>"}'`
(`mx-a2ea60`). The triggers row's `last_fired_at` is also written before
the extension clear is attempted — warren's DB is the source of truth, and
a failed clear gets surfaced as a system event on the dispatched run rather
than dropping the dispatch. This makes the duplicate-dispatch hazard fail
safe: the next tick reads the warren row, sees the recent fire, and skips.

**HTTP surface.** `GET /projects/:id/triggers` returns
`{triggers: TriggerSummary[], errors: WarrenConfigFileError[]}` (`mx-a93eb5`).
`POST /projects/:id/triggers/:triggerId/run` resolves the trigger from
warren-config, dispatches inline with `trigger='manual'` (Run Now is a human
press, not a cron fire), and returns the run row 201 (`mx-f3b48d`). Both
routes require the project row first (`mx-fa6ac7`) and surface
`WarrenConfigUnavailableError` if the loader can't read the YAML.

**UI surface.** `TriggersBlock` in `src/ui/src/pages/ProjectDetail.tsx`
(`mx-28b6a2`) renders the wire envelope: one row per trigger with cron
expression + last/next fire columns + Run Now button. YAML editing remains a
git operation per the R-02 read-only posture (`mx-a5e30e`).

**Acceptance.** Scenario 15
(`scripts/acceptance/scenarios/15-triggers-roundtrip.ts`) exercises three
shapes (`mx-6fc1ef`): a cron entry that fires once without double-dispatch,
a `scheduledFor` in the past + one in the future, and a trigger that
references a missing or closed seed. The scenario bootstraps
`.seeds/config.yaml` in the sample-source repo before driving the scheduler
(`mx-fc2827`).

**Adding new schema fields or new trigger kinds.** Per `mx-5339d5`, update
three places in lockstep: ROADMAP R-06 (or its successor entry), this record,
and acceptance scenario 15. New `TriggerSchema` fields must stay additive
(all-optional) so existing `triggers.yaml` files keep parsing —
warren-config (R-02) and the dispatcher (R-06) co-own the schema.
