import { useQuery } from "@tanstack/react-query";
// Relative import, not the `@/` alias — this module's tests run under
// the repo-root `bun test`, which resolves no `@/` (see format.test.ts).
import { getApiToken } from "../../api/client.ts";

/**
 * Judge-verdict consumption (warren-7197 / pl-7e38 step 14;
 * warren-f927 retargeted it at the warren proxy).
 *
 * The judge is an OPTIONAL warren extension (extensions/judge). Its
 * verdict export is reachable from the browser only through warren's
 * operator-gated reverse proxy, `GET /extensions/judge/verdicts.jsonl`
 * (warren-1b40): warren's CSP is `connect-src 'self'`, and the judge's
 * own credential lives server-side. The fetch below stays same-origin
 * and carries the warren bearer token via getApiToken(). It is still
 * deliberately NOT routed through `src/ui/src/api/client.ts`'s JSON
 * `request()` — the export is NDJSON text, not a JSON envelope.
 *
 * States are classified honestly (warren-f927):
 * - 501 from the proxy: the extension is genuinely absent/unconfigured.
 * - 401/403: deployed, but this browser holds no accepted credential.
 * - non-NDJSON body (the SPA index.html masquerade): "misconfigured",
 *   never silently swallowed parse failures.
 * - network throw / other non-OK: transport "error".
 * - an empty NDJSON body is a HEALTHY judge with zero verdicts, not an
 *   error (extensions/judge/src/server.ts emits exactly that plus the
 *   `X-Verdicts-Max-Id` high-water header).
 */

/** One class assignment in a verdict row (rubric v1, 15 classes). */
export interface JudgeAssignment {
	readonly class: string;
	readonly confidence: "low" | "medium" | "high";
}

/** The rubric-v1 verdict payload inside a `kind: "verdict"` row. */
export interface JudgeVerdictPayload {
	readonly runId: string;
	readonly assignments: readonly JudgeAssignment[];
	readonly provenance: {
		readonly provider: string;
		readonly model: string;
		readonly rubricVersion: string;
		readonly judgedAt: string;
		readonly costUsd: number;
	};
}

/** One row of the extension's append-only export. */
export interface JudgeStoreRow {
	readonly id: number;
	readonly kind: "verdict" | "unjudged";
	readonly runId: string;
	readonly rubricVersion: string;
	readonly judgeModelId: string;
	readonly verdict: JudgeVerdictPayload | null;
	readonly reason: string | null;
	readonly detail: string | null;
}

export type JudgeVerdictsAbsent = Extract<JudgeVerdictsState, { readonly available: false }>;

export type JudgeVerdictsState =
	| { readonly available: true; readonly rows: readonly JudgeStoreRow[] }
	| {
			readonly available: false;
			readonly reason: "absent" | "unauthorized" | "misconfigured" | "error";
	  };

/** Fetch page size: enough for a trend line, bounded on purpose. */
const VERDICT_PAGE_LIMIT = 500;

/**
 * The fetch window is the NEWEST page (warren-f282): `?order=desc` (warren
 * forwards the query verbatim, the judge serves the highest ids first), so
 * the strip reports recent verdicts instead of the first 500 ever recorded.
 */

export const JUDGE_VERDICTS_QUERY_KEY = ["telemetry", "judge-verdicts"] as const;

/** The warren proxy path (warren-1b40; same-origin under CSP). */
const JUDGE_PROXY_PATH = "/extensions/judge/verdicts.jsonl";

/** Does this response carry the judge export, not the SPA index.html? */
function isNdjsonResponse(res: Response, text: string): boolean {
	const contentType = res.headers.get("content-type") ?? "";
	if (contentType.length > 0 && !contentType.toLowerCase().includes("x-ndjson")) return false;
	// Content-type can be missing; a leading `<` is the SPA fallback.
	const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
	return !firstLine.trimStart().startsWith("<");
}

export async function fetchJudgeVerdicts(signal: AbortSignal): Promise<JudgeVerdictsState> {
	const headers: Record<string, string> = { accept: "application/x-ndjson" };
	const token = getApiToken();
	if (token !== null && token.length > 0) headers.authorization = `Bearer ${token}`;

	let res: Response;
	try {
		res = await fetch(`${JUDGE_PROXY_PATH}?limit=${String(VERDICT_PAGE_LIMIT)}&order=desc`, {
			headers,
			signal,
		});
	} catch {
		// Transport failure (offline, same-origin fetch rejected).
		return { available: false, reason: "error" };
	}

	if (res.status === 501) {
		// The warren proxy reports the extension as not configured.
		return { available: false, reason: "absent" };
	}
	if (res.status === 401 || res.status === 403) {
		// The extension is deployed but this browser holds no credential
		// it accepts (e.g. a WARREN_AUTH=public spectator).
		return { available: false, reason: "unauthorized" };
	}
	if (!res.ok) {
		// 502 and friends: the proxy is configured but the judge is
		// unreachable or rejected the export request.
		return { available: false, reason: "error" };
	}

	const text = await res.text();
	if (!isNdjsonResponse(res, text)) {
		// HTML (or another non-NDJSON body) can never read as a deployed
		// judge — classify instead of swallowing line-by-line parse noise.
		return { available: false, reason: "misconfigured" };
	}

	const rows: JudgeStoreRow[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			rows.push(JSON.parse(line) as JudgeStoreRow);
		} catch {
			// Skip a malformed line (e.g. a torn append) rather than drop
			// the whole page.
		}
	}
	// An empty page is a healthy judge with zero verdicts.
	return { available: true, rows };
}

/** Page the judge extension's verdict export; absent is a normal state. */
export function useJudgeVerdicts() {
	return useQuery({
		queryKey: JUDGE_VERDICTS_QUERY_KEY,
		queryFn: ({ signal }) => fetchJudgeVerdicts(signal),
		staleTime: 60_000,
		retry: false,
	});
}

export interface JudgeSummary {
	/** Verdicts whose assignments are `clean` (pass — clean is exclusive). */
	readonly pass: number;
	/** Verdicts with at least one non-clean class. */
	readonly fail: number;
	/** `kind: "unjudged"` marker rows. */
	readonly unjudged: number;
	/** pass / (pass + fail), null when no verdict has landed yet. */
	readonly passRate: number | null;
	/** (pass + fail) / all rows in the page, null when the page is empty.
	 * Coverage below 1 means the judge skipped runs (unjudged markers). */
	readonly judgedRate: number | null;
	/** Non-clean classes by assignment count, worst first. */
	readonly failingClasses: readonly { readonly name: string; readonly count: number }[];
	/** Distinct rubric versions in the page (e.g. "sha256:…"). */
	readonly rubricVersions: readonly string[];
}

/** Fold the raw rows into the Judge tab's figures. */
/** Is this verdict row clean (pass)? `clean` is exclusive in rubric v1. */
function isCleanVerdict(row: JudgeStoreRow): boolean {
	const assignments = row.verdict?.assignments ?? [];
	return assignments.length > 0 && assignments.every((a) => a.class === "clean");
}

/** Count one row's non-clean class assignments into the map. */
function countClasses(row: JudgeStoreRow, classCounts: Map<string, number>): void {
	for (const a of row.verdict?.assignments ?? []) {
		if (a.class === "clean") continue;
		classCounts.set(a.class, (classCounts.get(a.class) ?? 0) + 1);
	}
}

/** Fold the raw rows into the Judge tab's figures. */
export function summarizeJudgeVerdicts(rows: readonly JudgeStoreRow[]): JudgeSummary {
	let pass = 0;
	let fail = 0;
	let unjudged = 0;
	const classCounts = new Map<string, number>();
	const rubricVersions = new Set<string>();

	for (const row of rows) {
		rubricVersions.add(row.rubricVersion);
		if (row.kind === "unjudged") {
			unjudged += 1;
			continue;
		}
		if (row.verdict !== null && isCleanVerdict(row)) pass += 1;
		else {
			fail += 1;
			countClasses(row, classCounts);
		}
	}

	const judged = pass + fail;
	return {
		pass,
		fail,
		unjudged,
		passRate: judged === 0 ? null : pass / judged,
		judgedRate: rows.length === 0 ? null : judged / rows.length,
		failingClasses: [...classCounts.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
		rubricVersions: [...rubricVersions],
	};
}
