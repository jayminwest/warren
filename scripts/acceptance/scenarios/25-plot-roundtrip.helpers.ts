/**
 * Helper group for scenario 25 (`25-plot-roundtrip.ts`), split out
 * under the Article II file-size burn-down (warren-8a36, pl-91f7
 * step 1). Holds the row/response interfaces, fixture constants, and
 * the fixture-build / dispatch / polling helpers the scenario chains
 * together; the scenario body itself stays in the sibling file.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue } from "../lib/assert.ts";
import type { WarrenHttp } from "../lib/http.ts";

export interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly addedAt: string;
	readonly hasPlot?: boolean;
}

export interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly burrowId: string | null;
	readonly burrowRunId: string | null;
	readonly plotId: string | null;
}

export interface CreateRunResponse {
	readonly run: RunRow;
}

export interface CancelResponse {
	readonly state: string;
	readonly alreadyTerminal: boolean;
}

export interface EventRow {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: Record<string, unknown> | null;
	readonly plotId?: string | null;
}

export interface PlotListRow {
	readonly id: string;
	readonly name: string;
	readonly status: string;
}

export const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);
export const PLOT_PROJECT_URL = "https://github.com/warren-acceptance/sample-with-plot.git";

export interface BuildPlotFixtureInput {
	readonly fixturePath: string;
	readonly sourceFixturePath: string;
	readonly gitConfigPath: string;
	readonly redirectUrl: string;
}

/**
 * Build a sibling fixture project that mirrors the shared sample (same
 * burrow.toml + stub agent script) but additionally carries a committed
 * `.plot/` directory holding one pre-initialized Plot. Returns the plot
 * id so the scenario can dispatch with `plot_id=<id>`.
 *
 * The redirect line is appended (idempotent) to the harness's existing
 * git-config so warren clones via the fake gitUrl resolve to this on-disk
 * path. `git config insteadOf` is consulted on every `git` invocation, so
 * appending after warren boot is fine.
 */
export async function buildPlotFixture(input: BuildPlotFixtureInput): Promise<string> {
	await mkdir(input.fixturePath, { recursive: true });
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });

	const burrowToml = await readFile(join(input.sourceFixturePath, "burrow.toml"), "utf8");
	await writeFile(join(input.fixturePath, "burrow.toml"), burrowToml);
	await copyFile(
		join(input.sourceFixturePath, "tools", "stub-agent.sh"),
		join(input.fixturePath, "tools", "stub-agent.sh"),
	);
	await writeFile(
		join(input.fixturePath, "README.md"),
		"# warren acceptance plot fixture\n\nUsed by scripts/acceptance/scenarios/25-plot-roundtrip.ts.\n",
	);

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);

	// `plot init <name>` creates `.plot/plot-<id>.json` + events file +
	// .index.db. Run with a user actor so the seed `plot_created` event
	// is authored by user:* (Plot SPEC §6 — agent actors are forbidden
	// from `plot_created` for new plots).
	await runIn(input.fixturePath, ["plot", "init", "scenario-25"], {
		...env,
		PLOT_ACTOR: "user:acceptance",
	});

	const list = await runIn(input.fixturePath, ["plot", "list", "--json"], env);
	const plots = JSON.parse(list.stdout) as PlotListRow[];
	if (plots.length !== 1) {
		throw new AcceptanceError(
			`scenario-25 fixture: expected exactly one Plot after init, got ${plots.length}: ${list.stdout}`,
		);
	}
	const plotId = plots[0]?.id;
	if (plotId === undefined) {
		throw new AcceptanceError(`scenario-25 fixture: plot list --json missing id: ${list.stdout}`);
	}

	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(input.fixturePath, ["git", "commit", "-m", "init: plot acceptance fixture"], env);

	// Append the insteadOf entry to the shared git-config so warren's
	// `git clone <PLOT_PROJECT_URL>` lands on this on-disk path.
	const redirect = `[url "${input.fixturePath}"]\n\tinsteadOf = ${input.redirectUrl}\n`;
	const existing = await readFile(input.gitConfigPath, "utf8").catch(() => "");
	if (!existing.includes(`insteadOf = ${input.redirectUrl}`)) {
		await writeFile(input.gitConfigPath, `${existing}\n${redirect}`);
	}

	return plotId;
}

export interface DispatchAndCancelInput {
	readonly http: WarrenHttp;
	readonly projectId: string;
	readonly agentName: string;
	readonly plotId?: string;
	readonly promptSuffix: string;
}

export async function dispatchAndCancel(input: DispatchAndCancelInput): Promise<RunRow> {
	const prompt = `[sleep_ms=6000] ${input.promptSuffix}`;
	const body: Record<string, unknown> = {
		agent: input.agentName,
		project: input.projectId,
		prompt,
	};
	if (input.plotId !== undefined) body.plotId = input.plotId;
	const created = await input.http.expectJson<CreateRunResponse>("POST", "/runs", 201, { body });
	const run = created.run;
	assertTrue(
		typeof run.burrowRunId === "string" && run.burrowRunId !== null && run.burrowRunId.length > 0,
		"spawn response missing burrowRunId — plot scenario needs the run to reach burrow",
	);
	if (input.plotId !== undefined) {
		assertEqual(run.plotId, input.plotId, "spawn response carries the dispatched plot_id");
	}

	// Wait long enough for the bridge to mirror queued → running AND for
	// the stub-agent's early prints (PLOT_ID echo + `plot append`) to land
	// as events before we cancel. The stub's plot append happens on lines
	// 86-93 of agent.sh, which run before the sleep, so 1.5s is generous.
	await waitForRunning(input.http, run.id, 8_000);
	await sleep(1_500);

	const cancel = await input.http.expectJson<CancelResponse>(
		"POST",
		`/runs/${encodeURIComponent(run.id)}/cancel`,
		200,
		{ body: { reason: "scenario-25 cancel" } },
	);
	assertEqual(
		cancel.alreadyTerminal,
		false,
		"scenario-25 cancel should not report alreadyTerminal=true",
	);

	const finalState = await waitForTerminal(input.http, run.id, 12_000);
	assertTrue(
		TERMINAL_STATES.has(finalState),
		`run ${run.id} did not reach a terminal state; ended at '${finalState}'`,
	);
	// Re-read so the row carries the post-spawn plotId surface (warren-a8c3
	// persists it via attachBurrow's runs.update).
	return input.http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(run.id)}`, 200);
}

export async function ensureSampleProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

export async function waitForRunning(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<void> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row.state;
		if (row.state === "running") return;
		if (TERMINAL_STATES.has(row.state)) {
			throw new AcceptanceError(
				`run ${runId} reached terminal state '${row.state}' before bridge mirrored running (warren-3c40 territory)`,
			);
		}
		await sleep(100);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach 'running' within ${timeoutMs}ms (last state=${last})`,
	);
}

export async function waitForTerminal(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<string> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row.state;
		if (TERMINAL_STATES.has(row.state)) return row.state;
		await sleep(100);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach a terminal state within ${timeoutMs}ms (last state=${last})`,
	);
}

export async function fetchAllEvents(http: WarrenHttp, runId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

export function findTextEvent(events: readonly EventRow[], needle: string): EventRow | undefined {
	return events.find(
		(e) =>
			e.kind === "text" &&
			typeof e.payload?.text === "string" &&
			(e.payload.text as string).includes(needle),
	);
}

export function listTextEvents(events: readonly EventRow[]): string {
	return events
		.filter((e) => e.kind === "text" && typeof e.payload?.text === "string")
		.map((e) => `"${(e.payload?.text as string).slice(0, 120)}"`)
		.join(", ");
}

export async function waitForFileLineMatching(
	path: string,
	predicate: (line: string) => boolean,
	timeoutMs: number,
	label: string,
): Promise<void> {
	const start = Date.now();
	let lastBody = "";
	while (Date.now() - start < timeoutMs) {
		try {
			lastBody = await readFile(path, "utf8");
			for (const line of lastBody.split("\n")) {
				if (line.trim() === "") continue;
				if (predicate(line)) return;
			}
		} catch {
			// File not yet present — keep polling.
		}
		await sleep(100);
	}
	throw new AcceptanceError(
		`timed out after ${timeoutMs}ms waiting for ${label}; last body: ${lastBody.slice(0, 500)}`,
	);
}

export function summariseKinds(events: readonly EventRow[]): string {
	const counts = new Map<string, number>();
	for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
	return Array.from(counts.entries())
		.map(([k, n]) => `${k}×${n}`)
		.join(", ");
}

export interface RunResult {
	stdout: string;
	stderr: string;
}

export async function runIn(
	cwd: string,
	cmd: readonly string[],
	env: Record<string, string>,
): Promise<RunResult> {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new AcceptanceError(
			`scenario-25 fixture command failed (${cmd.join(" ")} in ${cwd}): exit ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`,
		);
	}
	return { stdout, stderr };
}

export function withGitIdentity(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "/tmp",
		GIT_AUTHOR_NAME: "Warren Acceptance",
		GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
		GIT_COMMITTER_NAME: "Warren Acceptance",
		GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
	};
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
