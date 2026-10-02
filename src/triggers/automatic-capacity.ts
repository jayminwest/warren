import type { Repos } from "../db/repos/index.ts";

export const DEFAULT_MAX_AUTOMATIC_CONCURRENT_RUNS = 1;
export const AUTOMATIC_RUN_TRIGGERS = ["cron", "scheduled", "ci-fixer", "plan-run"] as const;
export const AUTOMATIC_RUN_WINDOW_ENV = "WARREN_AUTOMATIC_RUN_WINDOW";
export const MAX_AUTOMATIC_CONCURRENT_RUNS_ENV = "WARREN_AUTOMATIC_MAX_CONCURRENT_RUNS";

export interface AutomaticRunPolicy {
	readonly maxConcurrentRuns: number;
	readonly window: string | undefined;
}

export function resolveAutomaticRunPolicy(
	env: Record<string, string | undefined> = process.env,
): AutomaticRunPolicy {
	const requestedMax = Number(env[MAX_AUTOMATIC_CONCURRENT_RUNS_ENV]);
	return {
		maxConcurrentRuns:
			Number.isSafeInteger(requestedMax) && requestedMax > 0
				? requestedMax
				: DEFAULT_MAX_AUTOMATIC_CONCURRENT_RUNS,
		window: env[AUTOMATIC_RUN_WINDOW_ENV] || undefined,
	};
}

export function isAutomaticRunTrigger(trigger: string): boolean {
	return AUTOMATIC_RUN_TRIGGERS.includes(trigger as (typeof AUTOMATIC_RUN_TRIGGERS)[number]);
}

/** Parse `HH:MM-HH:MM@IANA/Timezone`; an unset window leaves scheduling unrestricted. */
export function isWithinAutomaticRunWindow(
	now: Date,
	window = process.env[AUTOMATIC_RUN_WINDOW_ENV],
): boolean {
	if (!window) return true;
	const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})@(.+)$/.exec(window);
	if (!match) return false;
	const [, startHour, startMinute, endHour, endMinute, timezone] = match;
	const values = [startHour, startMinute, endHour, endMinute].map(Number);
	const [startH, startM, endH, endM] = values;
	if (
		startH === undefined ||
		startM === undefined ||
		endH === undefined ||
		endM === undefined ||
		startH > 23 ||
		endH > 23 ||
		startM > 59 ||
		endM > 59
	)
		return false;
	const start = startH * 60 + startM;
	const end = endH * 60 + endM;
	if (start === end) return false;
	try {
		const parts = new Intl.DateTimeFormat("en-GB", {
			timeZone: timezone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).formatToParts(now);
		const hour = Number(parts.find((part) => part.type === "hour")?.value);
		const minute = Number(parts.find((part) => part.type === "minute")?.value);
		const current = hour * 60 + minute;
		return start < end ? current >= start && current < end : current >= start || current < end;
	} catch {
		return false;
	}
}

export type AutomaticAdmissionResult<T> =
	| { readonly admitted: true; readonly value: T }
	| { readonly admitted: false };

let dispatchInProgress = false;

/** Serialize automatic dispatch admission across Warren's scheduler loops. */
export async function withAutomaticRunAdmission<T>(
	runs: Pick<Repos["runs"], "countNonTerminalAutomatic">,
	work: () => Promise<T>,
	now: Date = new Date(),
	policy: AutomaticRunPolicy = resolveAutomaticRunPolicy(),
): Promise<AutomaticAdmissionResult<T>> {
	if (!isWithinAutomaticRunWindow(now, policy.window)) return { admitted: false };
	if (dispatchInProgress) return { admitted: false };
	dispatchInProgress = true;
	try {
		if ((await runs.countNonTerminalAutomatic()) >= policy.maxConcurrentRuns) {
			return { admitted: false };
		}
		return { admitted: true, value: await work() };
	} finally {
		dispatchInProgress = false;
	}
}

export async function withAutomaticRetryAdmission(
	runs: Pick<Repos["runs"], "countNonTerminalAutomatic">,
	trigger: string,
	work: () => Promise<void>,
	onDenied: () => Promise<unknown>,
	now: Date = new Date(),
	policy: AutomaticRunPolicy = resolveAutomaticRunPolicy(),
): Promise<void> {
	if (!isAutomaticRunTrigger(trigger)) return work();
	const admission = await withAutomaticRunAdmission(runs, work, now, policy);
	if (!admission.admitted) await onDenied();
}
