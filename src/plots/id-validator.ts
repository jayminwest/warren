/**
 * Plot ID format validator (warren-bae5 / pl-5310 step 2).
 *
 * V1 Plot IDs are minted by the `@os-eco/plot-cli` library as
 * `plot-<lower-alphanum>+` (e.g. `plot-3e72876d`). Warren's dispatch
 * surfaces (POST /runs, POST /plan-runs) validate against this shape
 * BEFORE the warren row is inserted so a malformed input fails at
 * the operator-facing edge instead of silently no-opping at the
 * host-side `defaultPlotAppender` (src/runs/spawn.ts:407-425) and
 * surfacing far later as a "Plot no longer available" badge on the
 * run detail page.
 *
 * Origin: dogfood signal #4 from plot-3e72876d (warren-a353 →
 * warren-bae5). A user pasted the literal string
 * `plot_id=plot-3e72876d` into the NewRun plot_id input. The server
 * accepted it, the appender resolution failed quietly, the run still
 * dispatched, and the operator-facing signal was a stale badge after
 * the fact. The regex below is intentionally narrow — anything outside
 * `plot-<lower-alphanum>+` is rejected with `code='plot_id_invalid'`,
 * and well-formed-but-non-existent ids are rejected via the
 * PlotResolver (resolver.ts) with `code='plot_id_not_found'`.
 *
 * Empty string and `undefined` mean "no plot bound" — both flow
 * through unchanged. Callers should pass the *trimmed* value; this
 * module does not trim on behalf of the caller (the HTTP handlers
 * already normalize empty-string to "no plot" before reaching this
 * check).
 */

export const PLOT_ID_REGEX = /^plot-[a-z0-9]+$/;

export function isValidPlotIdFormat(plotId: string): boolean {
	return PLOT_ID_REGEX.test(plotId);
}
