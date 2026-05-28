import { readFile } from "node:fs/promises";
import { AcceptanceError } from "../../lib/assert.ts";
import type { WarrenHttp } from "../../lib/http.ts";
import type { PlanRunDetailResponse, PlotSnapshot } from "./types.ts";

const TERMINAL_PLAN_STATES = new Set(["succeeded", "failed", "cancelled"]);
const POLL_INTERVAL_MS = 500;

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForPlanState(
	http: WarrenHttp,
	planRunId: string,
	target: string,
	timeoutMs: number,
): Promise<PlanRunDetailResponse> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<PlanRunDetailResponse>(
			"GET",
			`/plan-runs/${encodeURIComponent(planRunId)}`,
			200,
		);
		last = row.planRun.state;
		if (row.planRun.state === target) return row;
		if (TERMINAL_PLAN_STATES.has(row.planRun.state)) {
			throw new AcceptanceError(
				`plan-run ${planRunId}: expected '${target}', reached terminal '${row.planRun.state}'`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`plan-run ${planRunId} did not reach '${target}' within ${timeoutMs}ms (last=${last})`,
	);
}

export async function readPlotSnapshot(path: string): Promise<PlotSnapshot> {
	const body = await readFile(path, "utf8");
	return JSON.parse(body) as PlotSnapshot;
}

export async function waitForPlotStatus(
	path: string,
	target: string,
	timeoutMs: number,
): Promise<PlotSnapshot> {
	const start = Date.now();
	let lastStatus = "unknown";
	while (Date.now() - start < timeoutMs) {
		try {
			const snap = await readPlotSnapshot(path);
			lastStatus = snap.status;
			if (snap.status === target) return snap;
		} catch {
			// not yet present or mid-write
		}
		await sleep(100);
	}
	throw new AcceptanceError(
		`Plot at ${path} did not reach status='${target}' within ${timeoutMs}ms (last=${lastStatus})`,
	);
}
