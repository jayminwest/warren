/**
 * Public surface for the closed-loop healer (warren-3db0, Phase 2).
 *
 * The healer wakes a dedicated pi-runtime agent when a production alert
 * (Sentry / Grafana) resolves to a warren-managed project. Intake lives
 * in `src/server/handlers/alerts.ts`; this module owns the pure pieces:
 * webhook normalization (`alert.ts`), the dispatch guard rails +
 * prompt (`dispatch.ts`), and alert→project routing (`resolve.ts`).
 */

/** Trigger string stamped on healer-dispatched runs. */
export const HEALER_TRIGGER = "healer";

/** System-event kind stamped on a healer run when it is dispatched. */
export const HEAL_DISPATCHED_EVENT = "heal.dispatched";

export {
	HEAL_ALERT_SOURCES,
	type HealAlert,
	type HealAlertSource,
	inferRepoSlug,
	isHealAlertSource,
	normalizeAlert,
	normalizeGrafanaAlert,
	normalizeSentryAlert,
} from "./alert.ts";
export {
	buildHealPrompt,
	type DecideHealDispatchInput,
	decideHealDispatch,
	type HealAttemptHistory,
	type HealDispatchDecision,
	type HealerSettings,
	type HealSkipReason,
} from "./dispatch.ts";
export {
	type HealProjectCandidate,
	type HealResolveResult,
	resolveHealProject,
} from "./resolve.ts";
