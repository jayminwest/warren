/**
 * Thin facade over `croner` (mx-b64542) — the only place in warren that
 * imports the cron library so the dialect choice stays swappable.
 *
 * Cron dialect: croner's `5-or-6-parts` mode (matches warren-config's
 * 5-or-6-token loose validation, mx-40fe51). Five fields are standard
 * Vixie cron (minute precision); six adds a leading seconds field for
 * sub-minute precision (Quartz-style). Day-of-week uses standard
 * numbering (Sunday=0..Saturday=6) — not the deprecated Quartz numbering.
 *
 * `parseCron` returns a discriminated `{ ok, ... }` shape so the
 * dispatcher can treat parse failures as a per-trigger skip (logged +
 * surfaced via `lastSkipReason` once the HTTP/UI surfaces land in R-06
 * steps 5/6) rather than letting them bubble up and kill the tick.
 *
 * Timezone defaults to "UTC" when omitted from the trigger entry — pl-2f15
 * risk #2 mitigation. The per-trigger `timezone` field is honored
 * verbatim; croner validates the IANA zone name and throws on garbage.
 */

import { Cron } from "croner";
import { formatError } from "../core/errors.ts";

export const DEFAULT_TIMEZONE = "UTC";

export interface ParsedCron {
	/**
	 * Greatest cron time `<= now`, or `null` when no past slot exists in
	 * the supported year range. Used by the dispatcher's "fire if prev >
	 * lastFiredAt" check.
	 */
	previousRun(now: Date): Date | null;
	/**
	 * Smallest cron time `> now`, or `null` when no future slot exists.
	 * Used to roll `nextFireAt` forward after a fire and to surface the
	 * next expected fire in the HTTP/UI response.
	 */
	nextRun(now: Date): Date | null;
}

export type ParseCronResult =
	| { readonly ok: true; readonly cron: ParsedCron }
	| { readonly ok: false; readonly message: string };

export interface ParseCronInput {
	readonly expression: string;
	readonly timezone?: string;
}

/**
 * Parse a cron expression for downstream scheduling. Lazy by design — the
 * dispatcher constructs one parsed instance per fire decision rather than
 * caching across ticks. Croner's Cron is cheap to instantiate and the
 * extra reference would have to be invalidated when the YAML changes;
 * leaving it stateless side-steps the cache invalidation problem.
 */
export function parseCron(input: ParseCronInput): ParseCronResult {
	const timezone = input.timezone ?? DEFAULT_TIMEZONE;
	let job: Cron;
	try {
		job = new Cron(input.expression, { timezone, paused: true });
		// Croner defers timezone validation until the first nextRun call.
		// Probe it eagerly so the dispatcher sees parse failures up front
		// instead of throwing mid-tick (pl-2f15 risk #1: surface invalid
		// dialect early so operators see "what's wrong" on GET /triggers).
		job.nextRun(new Date(0));
	} catch (err) {
		return { ok: false, message: formatError(err) };
	}
	return {
		ok: true,
		cron: {
			previousRun: (now) => {
				try {
					const runs = job.previousRuns(1, now);
					return runs.length > 0 ? (runs[0] as Date) : null;
				} catch {
					return null;
				}
			},
			nextRun: (now) => {
				try {
					return job.nextRun(now);
				} catch {
					return null;
				}
			},
		},
	};
}
