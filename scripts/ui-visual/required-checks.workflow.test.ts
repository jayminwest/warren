import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { load } from "js-yaml";
import { createGitFixtureSync } from "../../src/workspace/git/test-fixture.ts";

// warren-dbef: pins the wiring of the UI required-checks gate in
// .github/workflows/auto-merge.yml. The gate's rules are covered in
// required-checks.test.ts; this file executes the step's shell against a
// scratch git repo (as baseline-approval.workflow.test.ts does for the
// baseline gate) and checks the triggers, the sweep, and the arm conditions.

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GATE_PATH = "scripts/ui-visual/required-checks.ts";
const STEP_NAME = "UI required checks (ui-visual, design-review)";

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = {
	if?: string;
	needs?: string;
	outputs?: Record<string, string>;
	strategy?: { matrix?: Record<string, string> };
	steps?: Step[];
};
type Workflow = {
	on?: { workflow_run?: { workflows?: string[]; types?: string[] } };
	permissions?: Record<string, string>;
	jobs?: Record<string, Job>;
};

const wf = load(
	readFileSync(resolve(REPO_ROOT, ".github/workflows/auto-merge.yml"), "utf8"),
) as Workflow;
const armJob = wf.jobs?.["enable-auto-merge"];
const named = (job: Job | undefined, name: string): Step | undefined =>
	job?.steps?.find((s) => s.name === name);

/** A stand-in gate: writes `decision` (if any) to DECISION_FILE, then exits with `code`. */
function stubGate(decision: string | null, code: number): string {
	const write =
		decision === null
			? ""
			: `require("node:fs").appendFileSync(process.env.DECISION_FILE, "${decision}\\n");`;
	return `${write}\nprocess.exit(${code});\n`;
}

/** Put `baseGate` (or nothing) on origin/main and `headGate` on the PR branch, then run the step. */
function runStep(baseGate: string | null, headGate: string | null) {
	const run = named(armJob, STEP_NAME)?.run;
	if (run === undefined) throw new Error(`no "${STEP_NAME}" step`);
	const fixture = createGitFixtureSync({
		prefix: "warren-ui-checks-gate-",
		identity: { name: "test", email: "test@example.com" },
	});
	const dir = fixture.path;
	const put = (content: string) => {
		mkdirSync(join(dir, dirname(GATE_PATH)), { recursive: true });
		writeFileSync(join(dir, GATE_PATH), content);
	};
	try {
		writeFileSync(join(dir, "seed.txt"), "base\n");
		if (baseGate !== null) put(baseGate);
		fixture.git(["add", "-A"]);
		fixture.git(["commit", "-qm", "base"]);
		fixture.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
		fixture.git(["checkout", "-qb", "pr"]);
		if (headGate !== null) {
			put(headGate);
			fixture.git(["add", "-A"]);
			fixture.git(["commit", "-qm", "pr"]);
		}
		const runnerTemp = join(dir, ".runner-temp");
		mkdirSync(runnerTemp);
		const outputFile = join(dir, "gh-output");
		writeFileSync(outputFile, "");
		const result = Bun.spawnSync({
			cmd: ["bash", "-e", "-c", run],
			cwd: dir,
			env: {
				PATH: process.env.PATH ?? "",
				GITHUB_OUTPUT: outputFile,
				RUNNER_TEMP: runnerTemp,
				BASE_REF: "main",
				GIT_CEILING_DIRECTORIES: dirname(dir),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			lines: readFileSync(outputFile, "utf8").split("\n").filter(Boolean),
			exitCode: result.exitCode,
			log: `${result.stdout.toString()}${result.stderr.toString()}`,
		};
	} finally {
		fixture.cleanup();
	}
}

describe("the UI required checks step", () => {
	test("permits only when the base gate exits 0 and writes hit=false", () => {
		const r = runStep(stubGate("hit=false", 0), null);
		expect(r.lines).toEqual(["hit=false"]);
		expect(r.exitCode).toBe(0);
	});

	const refusals: [string, string | null, number][] = [
		["the gate refuses", "hit=true", 0],
		["the gate writes nothing", null, 0],
		["the gate crashes after writing hit=false", "hit=false", 1],
	];
	for (const [name, decision, code] of refusals) {
		test(`refuses when ${name}`, () => {
			const r = runStep(stubGate(decision, code), null);
			expect(r.lines).toEqual(["hit=true"]);
			expect(r.exitCode).toBe(0);
		});
	}

	test("refuses when the base branch has no gate, even if the PR adds a permissive one", () => {
		const r = runStep(null, stubGate("hit=false", 0));
		expect(r.lines).toEqual(["hit=true"]);
		expect(r.log).toContain("fail closed");
	});

	test("runs the base copy, not the PR's edited copy", () => {
		const r = runStep(stubGate("hit=true", 0), stubGate("hit=false", 0));
		expect(r.lines).toEqual(["hit=true"]);
	});
});

describe("auto-merge.yml wiring for the UI checks", () => {
	test("re-judges when a UI design review run completes", () => {
		expect(wf.on?.workflow_run?.workflows).toEqual(["UI design review"]);
		expect(wf.on?.workflow_run?.types).toEqual(["completed"]);
	});

	test("can read check runs and the workflow run behind a check suite", () => {
		expect(wf.permissions?.checks).toBe("read");
		expect(wf.permissions?.actions).toBe("read");
	});

	test("the sweep runs only on workflow_run and feeds the arm job's matrix", () => {
		const targets = wf.jobs?.targets;
		const sweep = named(targets, "Sweep open pull requests whose UI checks are green");
		expect(sweep?.if).toBe("github.event_name == 'workflow_run'");
		expect(sweep?.run).toBe("bun scripts/ui-visual/required-checks.ts targets");
		expect(targets?.outputs?.prs).toContain("steps.sweep.outputs.prs");
		expect(armJob?.needs).toBe("targets");
		expect(armJob?.strategy?.matrix?.pr).toContain("fromJSON(needs.targets.outputs.prs)");
		expect(armJob?.if).toContain("!= '[]'");
	});

	test("the gate runs from the base branch copy", () => {
		const step = named(armJob, STEP_NAME);
		expect(step?.id).toBe("ui_checks");
		expect(step?.run).toMatch(
			/git show "origin\/\$\{BASE_REF\}:scripts\/ui-visual\/required-checks\.ts"/,
		);
		expect(step?.env?.HEAD_SHA).toContain("matrix.pr.head_sha");
	});

	test("mints the token and arms only when the UI checks say hit=false", () => {
		for (const name of ["Mint app installation token", "Enable auto-merge (squash)"]) {
			expect(named(armJob, name)?.if).toContain("steps.ui_checks.outputs.hit == 'false'");
		}
	});

	test("disarms when the UI checks refuse", () => {
		const step = named(armJob, "Disarm auto-merge when a UI gate refuses");
		expect(step?.if).toContain("steps.ui_checks.outputs.hit != 'false'");
		expect(step?.run).toContain("--disable-auto");
	});

	test("the arm still pins the judged head", () => {
		expect(named(armJob, "Enable auto-merge (squash)")?.run).toContain(
			'--match-head-commit "$HEAD_SHA"',
		);
	});
});
