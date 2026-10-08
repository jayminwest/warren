import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

// Guards for warren-70d9: .github/workflows/ui-visual-comment.yml holds a
// write token, so it must stay a workflow_run follow-up that runs only the
// default branch's code and treats the ui-visual artifact as data.

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

type Step = {
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
};
type Workflow = {
	name?: string;
	on?: Record<string, { workflows?: string[]; types?: string[] } | null>;
	permissions?: Record<string, string>;
	jobs?: Record<string, { if?: string; steps?: Step[] }>;
};

function workflow(file: string): Workflow {
	return load(readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8")) as Workflow;
}

const comment = workflow("ui-visual-comment.yml");
const steps = comment.jobs?.comment?.steps ?? [];

describe("ui-visual-comment workflow", () => {
	test("follows completed runs of the ui-visual workflow by its name", () => {
		const trigger = comment.on?.workflow_run;
		expect(trigger?.workflows).toEqual([workflow("ui-visual.yml").name ?? ""]);
		expect(trigger?.types).toEqual(["completed"]);
	});

	test("reports only on PR runs that finished, plus manual dispatch", () => {
		const cond = comment.jobs?.comment?.if ?? "";
		expect(cond).toContain("github.event.workflow_run.event == 'pull_request'");
		expect(cond).toContain("workflow_dispatch");
	});

	test("checks out the default branch only and installs no packages", () => {
		const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
		expect(checkout?.with?.ref).toBeUndefined();
		expect(checkout?.with?.["persist-credentials"]).toBe(false);
		expect(steps.some((s) => s.run?.includes("install"))).toBe(false);
	});

	test("runs the comment script with the run id and a write token", () => {
		const post = steps.find((s) => s.run === "bun scripts/ui-visual/pr-comment.ts");
		expect(post?.env?.RUN_ID).toContain("github.event.workflow_run.id");
		expect(post?.env?.GH_TOKEN).toContain("steps.app-token.outputs.token");
		expect(comment.permissions).toMatchObject({ "pull-requests": "write", contents: "write" });
	});
});
