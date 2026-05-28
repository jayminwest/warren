import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcceptanceError } from "../../lib/assert.ts";
import { runIn, withGitIdentity } from "./git-helpers.ts";

export interface BuildFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
	readonly harnessGitConfigPath: string;
	readonly gitConfigPath: string;
	readonly projectGitUrl: string;
}

export interface BuildFixtureResult {
	readonly plotId: string;
	readonly questionAt: string;
}

const PLAN_ID = "pl-acc-29ab";
const SEED_A = "ah-acc29-aaaa";
const SEED_B = "ah-acc29-bbbb";
const MULCH_REF = "mx-acc290";
const SEED_TS = "2026-05-17T00:00:00.000Z";

export async function buildFixture29(input: BuildFixtureInput): Promise<BuildFixtureResult> {
	await mkdir(input.fixturePath, { recursive: true });
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });
	await mkdir(join(input.fixturePath, ".seeds"), { recursive: true });

	const burrowToml = await readFile(join(input.sourceSamplePath, "burrow.toml"), "utf8");
	await writeFile(join(input.fixturePath, "burrow.toml"), burrowToml);
	await copyFile(
		join(input.sourceSamplePath, "tools", "stub-agent.sh"),
		join(input.fixturePath, "tools", "stub-agent.sh"),
	);
	await copyFile(
		join(input.sourceSamplePath, "tools", "claude-code-stub-agent.sh"),
		join(input.fixturePath, "tools", "claude-code-stub-agent.sh"),
	);
	await writeFile(
		join(input.fixturePath, "README.md"),
		"# warren acceptance plot detail fixture\n\nUsed by scripts/acceptance/scenarios/29-plot-detail-roundtrip.ts.\n",
	);

	await writeFile(
		join(input.fixturePath, ".seeds", "config.yaml"),
		`project: "sample-plot-detail"\nversion: "1"\nmax_plan_depth: 3\n`,
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "issues.jsonl"),
		[seedRowOpen(SEED_A), seedRowOpen(SEED_B)].join(""),
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "plans.jsonl"),
		[planRow(PLAN_ID, [SEED_A, SEED_B])].join(""),
	);

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);

	const userEnv: Record<string, string> = { ...env, PLOT_ACTOR: "user:acceptance" };
	const agentEnv: Record<string, string> = {
		...env,
		PLOT_ACTOR: "agent:claude-code:scenario-29-seed",
	};

	await runIn(input.fixturePath, ["plot", "init", "scenario-29"], userEnv);
	const list = await runIn(input.fixturePath, ["plot", "list", "--json"], userEnv);
	const plots = JSON.parse(list.stdout) as ReadonlyArray<{ id: string }>;
	if (plots.length !== 1) {
		throw new AcceptanceError(
			`scenario-29 fixture: expected one Plot after init, got ${plots.length}: ${list.stdout}`,
		);
	}
	const plotId = plots[0]?.id;
	if (plotId === undefined) {
		throw new AcceptanceError(`scenario-29 fixture: plot list --json missing id`);
	}

	// drafting → ready → active so the auto-done has an active Plot to terminate.
	await runIn(input.fixturePath, ["plot", "status", plotId, "ready"], userEnv);
	await runIn(input.fixturePath, ["plot", "status", plotId, "active"], userEnv);

	// Attach the two pre-seeded refs. The sd_plan convention is a
	// `seeds_issue` attachment whose ref is a `pl-*` id (warren-5d94 /
	// isSdPlanAttachment in PlotDetail.tsx); update if plot-cli ever
	// grows a first-class `seeds_plan` kind.
	await runIn(
		input.fixturePath,
		["plot", "attach", plotId, `seeds_issue:${PLAN_ID}`, "--role", "primary"],
		userEnv,
	);
	await runIn(
		input.fixturePath,
		["plot", "attach", plotId, `mulch_record:${MULCH_REF}`, "--role", "context"],
		userEnv,
	);

	// Agent-authored question_posed so the answerer has a real
	// unanswered question to target. The agent actor route is the
	// only legal one for question_posed (SPEC §6 — humans-only event
	// types exclude it from the agent restriction but in practice
	// agents pose, users answer; using `agent:*` keeps the actor
	// consistent with how the warren stack would generate it).
	await runIn(
		input.fixturePath,
		[
			"plot",
			"append",
			plotId,
			"--event",
			"question_posed",
			"--data",
			JSON.stringify({ text: "scenario-29: which db?", blocking: true }),
		],
		agentEnv,
	);

	// Recover the `at` timestamp of the just-appended question_posed
	// from the events.jsonl tail — the wire :event_id is that ISO
	// string (warren-e1ac).
	const eventsBody = await readFile(
		join(input.fixturePath, ".plot", `${plotId}.events.jsonl`),
		"utf8",
	);
	let questionAt: string | undefined;
	for (const line of eventsBody.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const ev = JSON.parse(trimmed) as { type?: string; at?: string };
			if (ev.type === "question_posed" && typeof ev.at === "string") {
				questionAt = ev.at;
				break;
			}
		} catch {
			// non-JSON line, ignore
		}
	}
	if (questionAt === undefined) {
		throw new AcceptanceError(
			`scenario-29 fixture: could not find seeded question_posed in ${plotId}.events.jsonl`,
		);
	}

	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(
		input.fixturePath,
		["git", "commit", "-m", "init: plot detail acceptance fixture"],
		env,
	);

	const harnessConfig = await readFile(input.harnessGitConfigPath, "utf8").catch(() => "");
	const lines: string[] = [
		harnessConfig.trimEnd(),
		`[url "${input.fixturePath}"]`,
		`\tinsteadOf = ${input.projectGitUrl}`,
		"",
	];
	await writeFile(input.gitConfigPath, `${lines.join("\n")}\n`);

	return { plotId, questionAt };
}

function seedRowOpen(id: string): string {
	const row = {
		id,
		title: `scenario-29 ${id}`,
		status: "open",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
	};
	return `${JSON.stringify(row)}\n`;
}

function planRow(id: string, children: readonly string[]): string {
	const plan = {
		id,
		seed: "warren-acc-29",
		template: "feature",
		status: "approved",
		revision: 1,
		sections: {
			context: `scenario-29 acceptance plan ${id}`,
			approach: "dispatch child seeds via the plan-run coordinator",
			steps: children.map((s) => ({ title: `close ${s}` })),
		},
		children,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
		name: `scenario-29 ${id}`,
	};
	return `${JSON.stringify(plan)}\n`;
}
