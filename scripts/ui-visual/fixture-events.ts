/**
 * Event, tool-call, and judge-verdict generators for the ui-visual fixture
 * boot (warren-010b). Split from `fixture-data.ts` for the 500-line budget.
 *
 * Every payload mirrors a shape the live pipeline persists, so the UI
 * renders the fixture exactly as it renders a real run:
 *   - claude-code stream-json blocks as `jsonl-claude.ts` maps them
 *     (`text` / `thinking` / `tool_use` / `tool_result` on stdout,
 *     `state_change` on system);
 *   - `stderr` lines as the local engine appends them (`{ line }`);
 *   - warren-authored `steer.sent` / `reap.*` rows on system.
 *
 * No usage envelopes (`state_change` with `type: "result"`) are emitted:
 * those would let the usage hydrator recompute the seeded cost columns.
 */

import type { AppendEventInput } from "../../src/db/repos/events.ts";
import type { Repos } from "../../src/db/repos/index.ts";

/** One scripted tool round-trip on the running run. */
interface ToolStep {
	readonly say: string;
	readonly tool: "Bash" | "Read" | "Edit" | "Grep";
	readonly input: Readonly<Record<string, string>>;
	readonly result: string;
	readonly isError?: boolean;
	/** Optional stderr line the tool printed. */
	readonly stderr?: string;
}

const RUNNING_SCRIPT: readonly ToolStep[] = [
	{
		say: "I'll start by reading the runs table to see how the gutter is computed.",
		tool: "Read",
		input: { file_path: "src/ui/src/pages/runs/runs-table.tsx" },
		result: "export function RunsTable({ runs }: RunsTableProps) { … 212 lines … }",
	},
	{
		say: "Searching for the other call sites that share the gutter token.",
		tool: "Grep",
		input: { pattern: "gutter", path: "src/ui/src" },
		result: "src/ui/src/styles/tokens.css:41\nsrc/ui/src/pages/runs/runs-table.tsx:88",
	},
	{
		say: "Running the focused UI tests before changing anything.",
		tool: "Bash",
		input: { command: "bun test src/ui/src/pages/runs" },
		result: "12 pass\n0 fail\nRan 12 tests across 3 files. [214.00ms]",
	},
	{
		say: "The phone layout pads twice. Replacing the literal with the scale token.",
		tool: "Edit",
		input: {
			file_path: "src/ui/src/pages/runs/runs-table.tsx",
			old_string: "px-[18px]",
			new_string: "px-(--gutter)",
		},
		result: "The file src/ui/src/pages/runs/runs-table.tsx has been updated.",
	},
	{
		say: "Type-checking the UI package.",
		tool: "Bash",
		input: { command: "bun run typecheck" },
		result:
			"src/ui/src/pages/runs/runs-table.tsx(91,7): error TS2322: Type 'string' is not assignable to type 'Gutter'.",
		isError: true,
		stderr: 'error: script "typecheck" exited with code 2',
	},
	{
		say: "The Gutter union needs the new token. Updating the type.",
		tool: "Edit",
		input: {
			file_path: "src/ui/src/components/layout/gutter.ts",
			old_string: 'export type Gutter = "sm" | "md";',
			new_string: 'export type Gutter = "sm" | "md" | "token";',
		},
		result: "The file src/ui/src/components/layout/gutter.ts has been updated.",
	},
	{
		say: "Re-running the type check.",
		tool: "Bash",
		input: { command: "bun run typecheck" },
		result: "$ tsc --noEmit\n(no output)",
	},
	{
		say: "Linting with warnings treated as errors.",
		tool: "Bash",
		input: { command: "bun run lint" },
		result: "Checked 1412 files in 2s. No fixes applied.",
		stderr: "warning: biome cache directory missing, rebuilding",
	},
	{
		say: "Checking the phone snapshot helper for other fixed gutters.",
		tool: "Grep",
		input: { pattern: "px-\\[", path: "src/ui/src/pages/runs" },
		result: "(no matches)",
	},
	{
		say: "Running the full UI test suite now.",
		tool: "Bash",
		input: { command: "bun test src/ui" },
		result: "418 pass\n0 fail\nRan 418 tests across 61 files. [3.92s]",
	},
	{
		say: "Committing the fix.",
		tool: "Bash",
		input: { command: 'git commit -am "fix(ui): runs table gutter uses the scale token"' },
		result: "[warren/run_fx0000000102 4be1f2a] fix(ui): runs table gutter uses the scale token",
	},
];

/** Seconds between consecutive events on the running run's transcript. */
const EVENT_SPACING_S = 9;

/**
 * The running run's transcript: init + one text/tool_use/tool_result trio
 * per scripted step, interleaved stderr lines, a thinking block, and a
 * mid-run operator steer. 41 events for the 11-step script.
 */
export function runningRunEvents(runId: string, startedMs: number): AppendEventInput[] {
	const out: AppendEventInput[] = [];
	const push = (kind: string, stream: AppendEventInput["stream"], payload: unknown): void => {
		const seq = out.length + 1;
		const ts = new Date(startedMs + seq * EVENT_SPACING_S * 1000).toISOString();
		out.push({ runId, sandboxEventSeq: seq, ts, kind, stream, payload });
	};
	push("agent_start", "system", { runtime: "claude-code", model: "claude-sonnet-4-5" });
	push("state_change", "system", {
		type: "system",
		subtype: "init",
		cwd: "/workspace",
		model: "claude-sonnet-4-5",
		tools: ["Bash", "Read", "Edit", "Grep"],
	});
	push("thinking", "stdout", {
		text: "The issue says the runs table overflows at 393px. Likely a fixed gutter literal.",
	});
	RUNNING_SCRIPT.forEach((step, i) => {
		const toolUseId = `toolu_fx${String(i + 1).padStart(4, "0")}`;
		push("text", "stdout", { text: step.say });
		push("tool_use", "stdout", {
			type: "tool_use",
			id: toolUseId,
			name: step.tool,
			input: step.input,
		});
		if (step.stderr !== undefined) push("stderr", "stderr", { line: step.stderr });
		push("tool_result", "stdout", {
			type: "tool_result",
			tool_use_id: toolUseId,
			content: step.result,
			is_error: step.isError === true,
		});
		if (i === 5) {
			push("steer.sent", "system", {
				messageId: "msg_fx0000000001",
				priority: "normal",
				fromActor: "operator",
				body: "Keep the change scoped to the runs table; the plan-runs table has its own seed.",
			});
		}
	});
	push("stderr", "stderr", { line: "npm warn deprecated inflight@1.0.6: not supported" });
	push("text", "stdout", { text: "Pushing is warren's job — handing the branch back for reap." });
	return out;
}

/** Tool shapes the history runs cycle through for behavior mining. */
const HISTORY_TOOLS: readonly { tool: string; command: string | null; file: string | null }[] = [
	{ tool: "Bash", command: "bun test", file: null },
	{ tool: "Bash", command: "bun run lint", file: null },
	{ tool: "Edit", command: null, file: "src/ui/src/pages/telemetry/loop-tab.tsx" },
	{ tool: "Bash", command: "bun run typecheck", file: null },
	{ tool: "Read", command: null, file: "src/server/handlers/runs/analytics.ts" },
	{ tool: "Edit", command: null, file: "src/runs/reap/pr-merge-watcher.ts" },
	{ tool: "Bash", command: "git status", file: null },
];

export interface HistoryEventInput {
	readonly runId: string;
	readonly index: number;
	readonly startedMs: number;
	readonly endedMs: number;
	readonly prUrl: string | null;
	readonly steered: boolean;
}

/**
 * A terminal history run's compact transcript: four tool round-trips
 * (one erroring on every third run), an optional steer, and the reap
 * delivery markers (`reap.branch_pushed` / `reap.pr_opened`) the
 * analytics delivery block reads when the run opened a PR.
 */
export function historyRunEvents(input: HistoryEventInput): AppendEventInput[] {
	const out: AppendEventInput[] = [];
	const span = Math.max(input.endedMs - input.startedMs, 60_000);
	const push = (kind: string, stream: AppendEventInput["stream"], payload: unknown): void => {
		const seq = out.length + 1;
		const ts = new Date(input.startedMs + Math.round((span * seq) / 14)).toISOString();
		out.push({ runId: input.runId, sandboxEventSeq: seq, ts, kind, stream, payload });
	};
	push("agent_start", "system", { runtime: "claude-code" });
	for (let k = 0; k < 4; k++) {
		const shape = HISTORY_TOOLS[(input.index + k) % HISTORY_TOOLS.length];
		if (shape === undefined) continue;
		const toolUseId = `toolu_h${String(input.index).padStart(3, "0")}${k}`;
		const toolInput =
			shape.command !== null ? { command: shape.command } : { file_path: shape.file ?? "" };
		push("tool_use", "stdout", {
			type: "tool_use",
			id: toolUseId,
			name: shape.tool,
			input: toolInput,
		});
		const isError = k === 1 && input.index % 3 === 0;
		push("tool_result", "stdout", {
			type: "tool_result",
			tool_use_id: toolUseId,
			content: isError ? "error: 2 lint diagnostics" : "ok",
			is_error: isError,
		});
	}
	if (input.steered) {
		push("steer.sent", "system", {
			messageId: `msg_fxh${String(input.index).padStart(9, "0")}`,
			priority: "normal",
			fromActor: "operator",
			body: "Prefer the existing helper over a new one.",
		});
	}
	if (input.prUrl !== null) {
		push("reap.branch_pushed", "system", { branch: `warren/${input.runId}`, commitsAhead: 2 });
		push("reap.pr_opened", "system", { prUrl: input.prUrl, mode: "auto" });
		push("reap.completed", "system", {
			state: "succeeded",
			branchPushed: true,
			commitsAhead: 2,
			prUrl: input.prUrl,
		});
	}
	return out;
}

/**
 * Append the events and mirror every `tool_use` / `tool_result` pair into
 * the `tool_calls` rollup the behavior tab reads — the write the stream
 * bridge performs live (the boot backfill is idempotent on (run_id, seq)).
 */
export async function appendWithToolCalls(
	repos: Repos,
	events: readonly AppendEventInput[],
): Promise<number> {
	for (const e of events) {
		await repos.events.append(e);
		await mirrorToolCall(repos, e);
	}
	return events.length;
}

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** Mirror a tool_use / tool_result event into the `tool_calls` table. */
async function mirrorToolCall(repos: Repos, e: AppendEventInput): Promise<void> {
	const p = e.payload as Record<string, unknown>;
	if (e.kind === "tool_use") {
		const input = (p.input ?? {}) as Record<string, unknown>;
		const file = str(input.file_path);
		await repos.toolCalls.recordUse({
			runId: e.runId,
			seq: e.sandboxEventSeq,
			ts: e.ts,
			toolName: str(p.name),
			command: str(input.command),
			filePaths: file !== null ? [file] : [],
			toolUseId: str(p.id),
			origin: "agent",
		});
		return;
	}
	const toolUseId = str(p.tool_use_id);
	if (e.kind !== "tool_result" || toolUseId === null) return;
	await repos.toolCalls.recordResult({
		runId: e.runId,
		toolUseId,
		isError: p.is_error === true,
		resultBytes: str(p.content)?.length ?? null,
	});
}

/** Rubric-v1 classes the fixture verdicts rotate through (non-clean). */
const FAILING_CLASSES = [
	"scope_shortfall",
	"gate_flunk",
	"env_fumble",
	"spin_loop",
	"premature_success",
] as const;

/** Rubric version string stamped on every fixture verdict row. */
export const FIXTURE_RUBRIC_VERSION = "sha256:fx0rubric0v1";

/**
 * NDJSON rows for the fake judge export, newest id first (the UI asks for
 * `?order=desc`). Every third run fails a class; one run is `unjudged`.
 */
export function judgeExportRows(
	runs: readonly { readonly runId: string; readonly endedAt: string }[],
): string {
	const rows = runs.map((r, i) => {
		const id = i + 1;
		if (i === runs.length - 1) {
			return {
				id,
				kind: "unjudged",
				runId: r.runId,
				rubricVersion: FIXTURE_RUBRIC_VERSION,
				judgeModelId: "claude-haiku-4-5",
				verdict: null,
				reason: "transcript_too_short",
				detail: "fewer than 3 agent turns",
			};
		}
		const failing = i % 3 === 0;
		const cls = FAILING_CLASSES[i % FAILING_CLASSES.length] ?? "gate_flunk";
		return {
			id,
			kind: "verdict",
			runId: r.runId,
			rubricVersion: FIXTURE_RUBRIC_VERSION,
			judgeModelId: "claude-haiku-4-5",
			verdict: {
				runId: r.runId,
				assignments: failing
					? [{ class: cls, confidence: i % 2 === 0 ? "high" : "medium" }]
					: [{ class: "clean", confidence: "high" }],
				provenance: {
					provider: "anthropic",
					model: "claude-haiku-4-5",
					rubricVersion: FIXTURE_RUBRIC_VERSION,
					judgedAt: r.endedAt,
					costUsd: 0.0042,
				},
			},
			reason: null,
			detail: null,
		};
	});
	return `${rows
		.reverse()
		.map((r) => JSON.stringify(r))
		.join("\n")}\n`;
}
