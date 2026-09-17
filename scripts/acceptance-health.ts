/** Pure issue lifecycle policy for the nightly reporter (#1271). */
export const ISSUE_MARKER = "<!-- warren:acceptance-health -->";
const STATE_PREFIX = "<!-- acceptance-state:";

export interface NightlyRun {
	id: number;
	run_number: number;
	run_attempt: number;
	conclusion: string;
	head_sha: string;
	html_url: string;
}

export interface HealthState {
	run: number;
	attempt: number;
	failed: boolean;
	fingerprint: string;
}

export interface HealthIssue {
	number: number;
	state: string;
	body: string | null;
}

interface Outcome {
	id: string;
	title: string;
	status: "passed" | "failed" | "skipped";
}

/** Artifact content is data only, with bounded text and a checked shape. */
export function parseOutcomes(value: unknown): Outcome[] {
	if (typeof value !== "object" || value === null || !("outcomes" in value)) {
		throw new Error("Missing acceptance outcomes");
	}
	if (!Array.isArray(value.outcomes) || value.outcomes.length > 200) {
		throw new Error("Invalid acceptance outcomes");
	}
	return value.outcomes.map((row: unknown) => {
		if (typeof row !== "object" || row === null) throw new Error("Invalid outcome");
		if (
			!("id" in row) ||
			typeof row.id !== "string" ||
			row.id.length > 100 ||
			!("title" in row) ||
			typeof row.title !== "string" ||
			row.title.length > 1000 ||
			!("status" in row) ||
			(row.status !== "passed" && row.status !== "failed" && row.status !== "skipped")
		)
			throw new Error("Invalid outcome fields");
		return { id: row.id, title: row.title, status: row.status };
	});
}

export function readState(body: string | null): HealthState | undefined {
	const match = body?.match(/<!-- acceptance-state:(.*?) -->/);
	if (!match?.[1]) return undefined;
	try {
		const state: unknown = JSON.parse(match[1]);
		if (typeof state !== "object" || state === null) return undefined;
		if (
			"run" in state &&
			typeof state.run === "number" &&
			"attempt" in state &&
			typeof state.attempt === "number" &&
			"failed" in state &&
			typeof state.failed === "boolean" &&
			"fingerprint" in state &&
			typeof state.fingerprint === "string"
		)
			return state as HealthState;
	} catch {
		/* A manually edited marker is repaired on the next reconciliation. */
	}
	return undefined;
}

/** Cancellations (including concurrency supersession) never imply recovery. */
export function latestRelevantRun(runs: readonly NightlyRun[]): NightlyRun | undefined {
	return runs
		.filter((run) =>
			["success", "failure", "timed_out", "startup_failure"].includes(run.conclusion),
		)
		.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
}

function safeText(text: string): string {
	return text
		.replace(/[\r\n`<>]/g, " ")
		.replace(/@/g, "＠")
		.slice(0, 1000);
}

export function healthReport(
	run: NightlyRun,
	outcomes: readonly Outcome[] | undefined,
	failedSteps: readonly string[],
): { state: HealthState; body: string } {
	const failed = run.conclusion !== "success";
	const failedIds = outcomes
		?.filter((o) => o.status === "failed")
		.map((o) => o.id)
		.sort();
	const fingerprint = JSON.stringify([run.conclusion, failedIds ?? null, [...failedSteps].sort()]);
	const state = { run: run.run_number, attempt: run.run_attempt, failed, fingerprint };
	const lines = [
		ISSUE_MARKER,
		`${STATE_PREFIX}${JSON.stringify(state).replace(/</g, "\\u003c")} -->`,
		"",
		failed ? "Nightly acceptance is failing." : "Nightly acceptance has recovered.",
		"",
		`Latest run: [#${run.run_number}, attempt ${run.run_attempt}](${run.html_url})`,
		`Commit: \`${run.head_sha}\``,
		"",
	];
	if (outcomes) {
		const count = (status: Outcome["status"]) => outcomes.filter((o) => o.status === status).length;
		lines.push(
			`${count("passed")} passed, ${count("failed")} failed, ${count("skipped")} skipped`,
			"",
		);
		for (const row of outcomes.filter((o) => o.status === "failed").slice(0, 20)) {
			lines.push(`- ${safeText(row.id)}: ${safeText(row.title)}`);
		}
	} else {
		lines.push(
			"No scenario scoreboard is available. Inspect the run for setup or timeout failures.",
		);
	}
	if (failedSteps.length) {
		lines.push(
			"",
			"Failed workflow steps:",
			"",
			...failedSteps.map((step) => `- ${safeText(step)}`),
		);
	}
	lines.push(
		"",
		"This issue is maintained automatically. Repeated failures update this body; changed failures and recovery receive comments.",
	);
	return { state, body: lines.join("\n") };
}

export type HealthAction = "create" | "update" | "transition" | "ignore";

export function healthAction(issue: HealthIssue | undefined, next: HealthState): HealthAction {
	if (!issue) return next.failed ? "create" : "ignore";
	const previous = readState(issue.body);
	if (
		previous &&
		(previous.run > next.run || (previous.run === next.run && previous.attempt > next.attempt))
	)
		return "ignore";
	if (previous?.fingerprint !== next.fingerprint || (issue.state === "open") !== next.failed) {
		return "transition";
	}
	return "update";
}
