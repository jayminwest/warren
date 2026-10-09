import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { load } from "js-yaml";
import { createGitFixtureSync } from "../../src/workspace/git/test-fixture.ts";

// warren-4780: executes the shell that the "UI baseline approval check" step
// in .github/workflows/auto-merge.yml embeds, against a scratch git repo, the
// same way scripts/article-ix-gate.test.ts runs the Article IX step. The gate
// logic itself is covered in baseline-approval.test.ts; this file pins the
// wrapper: it runs the BASE branch's copy of the gate, and only an explicit
// `hit=false` from a gate that exited 0 permits arming.

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GATE_PATH = "scripts/ui-visual/baseline-approval.ts";

type Step = { name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function stepScript(): string {
	const raw = readFileSync(resolve(REPO_ROOT, ".github/workflows/auto-merge.yml"), "utf8");
	const wf = load(raw) as Workflow;
	const step = wf.jobs?.["enable-auto-merge"]?.steps?.find(
		(s) => s.name === "UI baseline approval check",
	);
	if (step?.run === undefined) throw new Error("no UI baseline approval check step");
	return step.run;
}

/** A stand-in gate: writes `decision` (if any) to DECISION_FILE, then exits with `code`. */
function stubGate(decision: string | null, code: number): string {
	const write =
		decision === null
			? ""
			: `require("node:fs").appendFileSync(process.env.DECISION_FILE, "${decision}\\n");`;
	return `${write}\nprocess.exit(${code});\n`;
}

/**
 * Commit `baseGate` (or nothing) as the gate on the base branch, point
 * origin/main at it, then put `headGate` on the PR branch and run the step.
 */
function runStep(baseGate: string | null, headGate: string | null) {
	const fixture = createGitFixtureSync({
		prefix: "warren-baseline-gate-",
		identity: { name: "test", email: "test@example.com" },
	});
	const dir = fixture.path;
	const git = fixture.git;
	const put = (content: string) => {
		mkdirSync(join(dir, dirname(GATE_PATH)), { recursive: true });
		writeFileSync(join(dir, GATE_PATH), content);
	};
	try {
		writeFileSync(join(dir, "seed.txt"), "base\n");
		if (baseGate !== null) put(baseGate);
		git(["add", "-A"]);
		git(["commit", "-qm", "base"]);
		git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
		git(["checkout", "-qb", "pr"]);
		if (headGate !== null) {
			put(headGate);
			git(["add", "-A"]);
			git(["commit", "-qm", "pr"]);
		}
		const runnerTemp = join(dir, ".runner-temp");
		mkdirSync(runnerTemp);
		const outputFile = join(dir, "gh-output");
		writeFileSync(outputFile, "");
		const result = Bun.spawnSync({
			cmd: ["bash", "-e", "-c", stepScript()],
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
		const lines = readFileSync(outputFile, "utf8").split("\n").filter(Boolean);
		return {
			lines,
			exitCode: result.exitCode,
			log: `${result.stdout.toString()}${result.stderr.toString()}`,
		};
	} finally {
		fixture.cleanup();
	}
}

describe("the UI baseline approval step", () => {
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
