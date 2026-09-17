/** GitHub Actions transport. Uses only default-branch code and treats artifacts as data. */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type HealthIssue,
	healthAction,
	healthReport,
	ISSUE_MARKER,
	latestRelevantRun,
	type NightlyRun,
	parseOutcomes,
} from "./acceptance-health.ts";

const repo = process.env.GH_REPO;
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("GH_REPO is required");
const base = `repos/${repo}`;

function api<T>(path: string, payload?: object): T {
	const args = ["api", path];
	if (payload) args.push("--method", "POST", "--input", "-");
	return JSON.parse(
		execFileSync("gh", args, {
			encoding: "utf8",
			input: payload ? JSON.stringify(payload) : undefined,
		}),
	);
}

function pages<T>(path: string): T[] {
	return JSON.parse(
		execFileSync("gh", ["api", path, "--paginate", "--slurp"], {
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
		}),
	);
}

interface Job {
	name: string;
	conclusion: string;
	steps?: { name: string; conclusion: string }[];
}

async function scoreboard(run: NightlyRun): Promise<ReturnType<typeof parseOutcomes> | undefined> {
	const name = `acceptance-results-${run.run_attempt}`;
	const artifacts = pages<{ artifacts: { name: string; expired: boolean }[] }>(
		`${base}/actions/runs/${run.id}/artifacts?per_page=100`,
	).flatMap((page) => page.artifacts);
	if (!artifacts.some((artifact) => artifact.name === name && !artifact.expired)) return undefined;
	const dir = await mkdtemp(join(tmpdir(), "acceptance-report-"));
	try {
		execFileSync("gh", [
			"run",
			"download",
			String(run.id),
			"--repo",
			repo ?? "",
			"--name",
			name,
			"--dir",
			dir,
		]);
		const content = await readFile(join(dir, "acceptance.json"), "utf8");
		if (content.length > 1_000_000) throw new Error("Acceptance artifact is too large");
		return parseOutcomes(JSON.parse(content));
	} catch (error) {
		console.warn(`::warning::Cannot read acceptance scoreboard: ${String(error)}`);
		return undefined;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function failedWorkflowSteps(run: NightlyRun): string[] {
	const jobs = pages<{ jobs: Job[] }>(
		`${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
	).flatMap((page) => page.jobs);
	return jobs
		.filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped")
		.flatMap((job) => {
			const steps = job.steps?.filter((step) => ["failure", "timed_out"].includes(step.conclusion));
			return steps?.length
				? steps.map((step) => `${job.name}: ${step.name}`)
				: [`${job.name}: ${job.conclusion}`];
		});
}

function createIssue(title: string, body: string): void {
	const repository = api<{ owner: { login: string; type: string } }>(base);
	const assignee =
		process.env.NIGHTLY_ISSUE_ASSIGNEE ||
		(repository.owner.type === "User" ? repository.owner.login : undefined);
	api(`${base}/issues`, {
		title,
		body,
		...(assignee ? { assignees: [assignee] } : {}),
	});
	console.log("Opened nightly acceptance health issue.");
}

async function main(): Promise<void> {
	// Reconcile the newest completed result, even when this event was delayed.
	// An older rerun must never close an incident from a newer nightly.
	const runs = pages<{ workflow_runs: NightlyRun[] }>(
		`${base}/actions/workflows/acceptance.yml/runs?branch=main&status=completed&per_page=100`,
	).flatMap((page) => page.workflow_runs);
	const run = latestRelevantRun(runs);
	if (!run) return;
	const issues = pages<(HealthIssue & { user: { login: string }; pull_request?: unknown })[]>(
		`${base}/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100`,
	).flat();
	const issue = issues.find(
		(row) =>
			!row.pull_request &&
			row.user.login === "github-actions[bot]" &&
			row.body?.startsWith(ISSUE_MARKER),
	);
	const report = healthReport(run, await scoreboard(run), failedWorkflowSteps(run));
	const action = healthAction(issue, report.state);
	if (action === "ignore") return;
	const title = "Nightly acceptance health";
	if (action === "create") {
		createIssue(title, report.body);
		return;
	}
	if (!issue) throw new Error("Expected an existing health issue");
	if (action === "transition") {
		// A retry after posting a comment but before updating the issue is quiet.
		const marker = `<!-- acceptance-transition:${run.id}:${run.run_attempt} -->`;
		const comments = pages<{ body: string; user: { login: string } }[]>(
			`${base}/issues/${issue.number}/comments?per_page=100`,
		).flat();
		if (
			!comments.some(
				(comment) =>
					comment.user.login === "github-actions[bot]" && comment.body.startsWith(marker),
			)
		) {
			api(`${base}/issues/${issue.number}/comments`, {
				body: `${marker}\n${report.state.failed ? "Failure changed or recurred." : "Recovered."}\n\n${report.body}`,
			});
		}
	}
	// PATCH is explicit: POST is reserved for creates above.
	execFileSync(
		"gh",
		["api", `${base}/issues/${issue.number}`, "--method", "PATCH", "--input", "-"],
		{
			input: JSON.stringify({
				title,
				body: report.body,
				state: report.state.failed ? "open" : "closed",
				state_reason: report.state.failed ? "reopened" : "completed",
			}),
			stdio: ["pipe", "ignore", "inherit"],
		},
	);
	console.log(`Reconciled nightly acceptance health issue #${issue.number}: ${action}.`);
}

await main();
