# Automatic run admission

**Kind:** contract
**Design state:** proposed
**Delivery:** unscheduled
**Arrived:** 2026-10-02
**Current truth:** `src/triggers/automatic-capacity.ts` and `.env.example`

Warren limits automatic work per server process using the queued/running run records. Automatic trigger classes are cron, scheduled seeds, CI fixer, and plan-run coordination. Manual runs remain operator-controlled and do not consume the automatic-run limit.

The default `WARREN_AUTOMATIC_MAX_CONCURRENT_RUNS=1` allows one non-terminal automatic run per Warren instance. Set a positive integer to change the per-instance limit. Invalid values use the safe default of one.

An optional `WARREN_AUTOMATIC_RUN_WINDOW` value limits automatic dispatch and automatic provider retries to a local-time interval. Format: `HH:MM-HH:MM@IANA/Timezone`, for example `02:00-09:00@Europe/Madrid`. The start is inclusive and the end is exclusive. Overnight intervals are supported. An unset value leaves scheduling unrestricted; malformed values fail closed for automatic work.

When capacity is occupied or a run is outside the configured window, due scheduler work remains queued for a later tick. Automatic retries preserve the failed run's provider/model overrides, so a local-provider failure remains a local-provider failure. Manual retries continue outside the automatic admission policy.

These limits apply independently to each Warren instance. Multiple instances sharing one inference service require a shared external capacity policy or a staggered schedule if their combined concurrency must stay below the sum of their per-instance limits.
