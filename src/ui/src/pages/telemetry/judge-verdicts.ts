import { useQuery } from "@tanstack/react-query";
import { getApiToken } from "@/api/client.ts";

/**
 * Judge-verdict consumption (warren-7197 / pl-7e38 step 14).
 *
 * The judge is an OPTIONAL warren extension (extensions/judge). It is
 * never part of the core server, so this fetch targets the extension's
 * published HTTP surface (`GET /verdicts.jsonl`) directly — deliberately
 * NOT routed through `src/ui/src/api/client.ts`, whose paths
 * `check:client-contract` holds to the warren ROUTE_TABLE. Extension
 * awareness must not leak into core modules (extensions seam,
 * docs/design/extensions.md), and a fetch the warren server does not
 * serve is exactly the drift that gate exists to catch.
 *
 * The base URL defaults to same-origin (a reverse proxy fronts the
 * extension in that deployment); override with `VITE_JUDGE_BASE_URL`.
 * Any non-OK response or network failure is the ABSENT state — the
 * extension not being deployed is a normal condition, never an error
 * banner.
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
	| { readonly available: false; readonly reason: "absent" | "unauthorized" | "error" };

/** Fetch page size: enough for a trend line, bounded on purpose. */
const VERDICT_PAGE_LIMIT = 500;

const JUDGE_BASE_URL: string = import.meta.env.VITE_JUDGE_BASE_URL ?? "";

export const JUDGE_VERDICTS_QUERY_KEY = ["telemetry", "judge-verdicts"] as const;

async function fetchJudgeVerdicts(signal: AbortSignal): Promise<JudgeVerdictsState> {
	const headers: Record<string, string> = { accept: "application/x-ndjson" };
	const token = getApiToken();
	if (token !== null && token.length > 0) headers.authorization = `Bearer ${token}`;

	let res: Response;
	try {
		res = await fetch(`${JUDGE_BASE_URL}/verdicts.jsonl?limit=${String(VERDICT_PAGE_LIMIT)}`, {
			headers,
			signal,
		});
	} catch {
		// Network failure = not deployed at this origin (or offline).
		return { available: false, reason: "absent" };
	}

	if (!res.ok) {
		return {
			available: false,
			// 401/403: the extension is deployed but this browser holds no
			// credential it accepts (e.g. a WARREN_AUTH=public spectator).
			reason: res.status === 401 || res.status === 403 ? "unauthorized" : "absent",
		};
	}

	const text = await res.text();
	const rows: JudgeStoreRow[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			rows.push(JSON.parse(line) as JudgeStoreRow);
		} catch {
			// Skip a malformed line rather than drop the whole page.
		}
	}
	if (rows.length === 0) return { available: false, reason: "error" };
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
		failingClasses: [...classCounts.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
		rubricVersions: [...rubricVersions],
	};
}
