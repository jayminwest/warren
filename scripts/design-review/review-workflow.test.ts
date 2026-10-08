import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

// Guards for warren-a694: .github/workflows/ui-design-review.yml writes a
// required check and a PR comment and runs a model over PR data, so it
// must run only the default branch's code, keep each job's token minimal,
// and keep PR text out of the evaluator's instructions.

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

type Step = {
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
};
type Job = {
	if?: string;
	needs?: string | string[];
	permissions?: Record<string, string>;
	steps?: Step[];
};
type Workflow = {
	name?: string;
	on?: Record<string, { workflows?: string[]; types?: string[] } | null>;
	permissions?: Record<string, string>;
	jobs?: Record<string, Job>;
};

/** A GitHub expression, `${{ ... }}`, built so Biome does not read it as a template slip. */
function expr(body: string): string {
	return `$${"{{"} ${body} }}`;
}

function read(file: string): string {
	return readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8");
}

const text = read("ui-design-review.yml");
const wf = load(text) as Workflow;
const jobs = wf.jobs ?? {};
const evaluator = (jobs.evaluate?.steps ?? []).find((s) =>
	s.uses?.startsWith("anthropics/claude-code-action@"),
);

describe("ui-design-review workflow", () => {
	test("gates every PR, follows ui-visual by name, and has no push trigger", () => {
		expect(Object.keys(wf.on ?? {}).sort()).toEqual([
			"pull_request_target",
			"workflow_dispatch",
			"workflow_run",
		]);
		const ui = load(read("ui-visual.yml")) as Workflow;
		expect(wf.on?.workflow_run?.workflows).toEqual([ui.name ?? ""]);
		expect(wf.on?.workflow_run?.types).toEqual(["completed"]);
		expect(jobs.gate?.if).toBe("github.event_name == 'pull_request_target'");
	});

	test("grants no token by default and least privilege per job", () => {
		expect(wf.permissions).toEqual({});
		expect(jobs.gate?.permissions).toEqual({
			checks: "write",
			contents: "read",
			"pull-requests": "read",
		});
		expect(jobs.evaluate?.permissions).toEqual({ contents: "read" });
		expect(jobs.report?.permissions).toEqual({
			checks: "write",
			contents: "read",
			"pull-requests": "write",
		});
		for (const job of Object.values(jobs)) {
			expect(job.permissions?.contents).toBe("read");
		}
	});

	test("checks out only the default branch and never installs the PR's packages", () => {
		for (const job of Object.values(jobs)) {
			for (const step of job.steps ?? []) {
				if (step.uses?.startsWith("actions/checkout@")) {
					expect(step.with?.ref).toBeUndefined();
					expect(step.with?.["persist-credentials"]).toBe(false);
				}
				expect(step.run ?? "").not.toContain("install");
			}
		}
	});

	test("pins the evaluator action to a commit and bounds it", () => {
		expect(evaluator?.uses).toMatch(/^anthropics\/claude-code-action@[0-9a-f]{40}$/);
		const args = String(evaluator?.with?.claude_args ?? "");
		expect(args).toContain("--max-turns");
		expect(args).toContain("--max-budget-usd");
		expect(args).toContain(`--model ${expr("env.DESIGN_REVIEW_MODEL")}`);
		expect(text).toContain("vars.DESIGN_REVIEW_MODEL ||");
	});

	test("scopes the evaluator's tools to reading, one verdict file, and the validator", () => {
		const args = String(evaluator?.with?.claude_args ?? "");
		const allowed = args.slice(args.indexOf("--allowedTools"), args.indexOf("--disallowedTools"));
		expect(allowed).not.toMatch(/"Bash"|"Bash\(\*/);
		expect(allowed).not.toMatch(/"(Write|Edit)"/);
		expect(allowed).toContain('"Bash(bun run scripts/design-review/verdict.ts:*)"');
		expect(allowed).toContain('"Edit(./.design-review/verdict.json)"');
		for (const tool of ["WebFetch", "WebSearch"]) {
			expect(args.slice(args.indexOf("--disallowedTools"))).toContain(`"${tool}"`);
		}
	});

	test("feeds the evaluator no PR-authored text as instructions", () => {
		const prompt = String(evaluator?.with?.prompt ?? "");
		expect(prompt).toContain("ui-design-review");
		expect(prompt).not.toMatch(
			/github\.event\.(pull_request|workflow_run)\.(title|body|head_branch)/,
		);
		expect(prompt).not.toContain("display_title");
		expect(prompt).not.toContain("head_commit");
		const exprs = prompt.match(/\$\{\{[^}]*\}\}/g) ?? [];
		expect(exprs.sort()).toEqual([
			expr("needs.prepare.outputs.head_sha"),
			expr("needs.prepare.outputs.pages"),
		]);
	});

	test("reports after every review path, from main's scripts", () => {
		expect(jobs.report?.needs).toEqual(["prepare", "evaluate"]);
		expect(jobs.report?.if).toContain("always()");
		const runs = Object.values(jobs).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ""));
		expect(runs).toContain("bun scripts/design-review/gate.ts");
		expect(runs).toContain("bun scripts/design-review/prepare.ts");
		expect(runs).toContain("bun scripts/design-review/report.ts");
	});
});
