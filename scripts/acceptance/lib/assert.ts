/**
 * Tiny scenario runner for the acceptance harness.
 *
 * The acceptance suite is not `bun test` — it boots real processes and
 * touches real disk, and we want a top-level pass/fail table the operator
 * can read at a glance. This module gives us:
 *
 *   - `Scenario` — one acceptance criterion, with `setup`/`run`/`teardown`.
 *   - `runScenarios(...)` — runs them in declared order, captures
 *     duration + outcome, prints a table, returns an exit code.
 *
 * Each scenario receives a `Ctx` object the harness fills in (warren URL,
 * bearer token, fixture paths, etc.), and may declare which boot modes it
 * supports (`inProc`, `container`, or both).
 */
export type BootMode = "in-proc" | "container";

export interface ScenarioCtx {
	readonly mode: BootMode;
	readonly warrenUrl: string;
	readonly token: string;
	readonly fixtures: {
		readonly canopyRepoUrl: string;
		readonly canopyRepoPath: string;
		readonly sampleProjectGitUrl: string;
		readonly sampleProjectName: string;
		readonly sampleProjectPath: string;
		readonly stubAgentName: string;
		readonly knownSeedTitle: string;
		readonly knownMulchDomain: string;
	};
	readonly logger: ScenarioLogger;
	readonly tmp: string;
	/**
	 * Lifecycle handle for scenarios that need to drive process control
	 * (restart-recovery, supervisor restart-budget). Populated by the
	 * harness; absent in container mode until the compose launcher lands.
	 * Scenarios that need it should declare in-proc-only and assert
	 * presence — calling without checking is a hard error.
	 */
	readonly lifecycle?: ScenarioLifecycle;
}

export interface ScenarioLifecycle {
	/** Force-stop warren; burrow keeps running. Bridge connections drop. */
	killWarren(): Promise<void>;
	/** Re-spawn warren after killWarren and wait for /healthz. */
	restartWarren(): Promise<void>;
	/** Force-stop burrow (for supervisor restart-budget scenarios). */
	killBurrow(): Promise<void>;
}

export interface ScenarioLogger {
	info(msg: string): void;
	warn(msg: string): void;
	debug(msg: string): void;
}

export interface Scenario {
	readonly id: string;
	readonly title: string;
	readonly modes: readonly BootMode[];
	run(ctx: ScenarioCtx): Promise<void>;
}

export interface ScenarioOutcome {
	readonly id: string;
	readonly title: string;
	readonly status: "passed" | "failed" | "skipped";
	readonly durationMs: number;
	readonly error?: string;
}

export interface RunScenariosOptions {
	readonly mode: BootMode;
	readonly stopOnFailure?: boolean;
	readonly only?: ReadonlySet<string>;
}

export async function runScenarios(
	scenarios: readonly Scenario[],
	ctx: ScenarioCtx,
	opts: RunScenariosOptions,
): Promise<{ outcomes: readonly ScenarioOutcome[]; exitCode: number }> {
	const outcomes: ScenarioOutcome[] = [];
	for (const scenario of scenarios) {
		if (opts.only !== undefined && !opts.only.has(scenario.id)) continue;
		const supportsMode = scenario.modes.includes(opts.mode);
		if (!supportsMode) {
			outcomes.push({
				id: scenario.id,
				title: scenario.title,
				status: "skipped",
				durationMs: 0,
				error: `not supported in ${opts.mode} mode`,
			});
			continue;
		}
		const start = Date.now();
		ctx.logger.info(`▶ ${scenario.id} ${scenario.title}`);
		try {
			await scenario.run(ctx);
			const durationMs = Date.now() - start;
			outcomes.push({ id: scenario.id, title: scenario.title, status: "passed", durationMs });
		} catch (err) {
			const durationMs = Date.now() - start;
			const message = err instanceof Error ? `${err.message}` : String(err);
			outcomes.push({
				id: scenario.id,
				title: scenario.title,
				status: "failed",
				durationMs,
				error: message,
			});
			if (opts.stopOnFailure) break;
		}
	}
	const failed = outcomes.filter((o) => o.status === "failed").length;
	return { outcomes, exitCode: failed === 0 ? 0 : 1 };
}

export function formatOutcomes(outcomes: readonly ScenarioOutcome[]): string {
	const lines: string[] = [];
	lines.push("");
	lines.push("Acceptance results:");
	for (const o of outcomes) {
		const icon = o.status === "passed" ? "✓" : o.status === "skipped" ? "○" : "✗";
		const dur = `${o.durationMs}ms`.padStart(7);
		lines.push(`  ${icon} ${o.id.padEnd(4)} ${dur}  ${o.title}`);
		if (o.error !== undefined) lines.push(`        ↳ ${o.error}`);
	}
	const passed = outcomes.filter((o) => o.status === "passed").length;
	const failed = outcomes.filter((o) => o.status === "failed").length;
	const skipped = outcomes.filter((o) => o.status === "skipped").length;
	lines.push("");
	lines.push(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);
	return lines.join("\n");
}

export class AcceptanceError extends Error {
	constructor(message: string, opts?: { cause?: unknown }) {
		super(message, opts);
		this.name = "AcceptanceError";
	}
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
	if (actual !== expected) {
		throw new AcceptanceError(`${message}: expected ${jsonish(expected)}, got ${jsonish(actual)}`);
	}
}

export function assertTrue(cond: boolean, message: string): asserts cond {
	if (!cond) throw new AcceptanceError(message);
}

export function assertContains(haystack: string, needle: string, message: string): void {
	if (!haystack.includes(needle)) {
		throw new AcceptanceError(`${message}: expected to contain ${jsonish(needle)}`);
	}
}

function jsonish(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
