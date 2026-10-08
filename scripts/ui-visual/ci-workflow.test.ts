import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

// Guards for warren-5aa3: .github/workflows/ui-visual.yml runs the harness in
// the official Playwright image. The image ships the browser build for one
// Playwright release, so its tag must track the @playwright/test
// devDependency, and goldens (warren-a132) are only comparable when the
// image cannot move under a fixed tag.

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const WORKFLOW = ".github/workflows/ui-visual.yml";

type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Job = {
	name?: string;
	"timeout-minutes"?: number;
	container?: { image?: string };
	steps?: Step[];
};
type Workflow = {
	on?: Record<string, { paths?: string[] } | null>;
	concurrency?: { group?: string };
	jobs?: Record<string, Job>;
};

function loadWorkflow(): Workflow {
	return load(readFileSync(resolve(REPO_ROOT, WORKFLOW), "utf8")) as Workflow;
}

function playwrightVersion(): string {
	const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
		devDependencies?: Record<string, string>;
	};
	const version = pkg.devDependencies?.["@playwright/test"];
	if (version === undefined) throw new Error("@playwright/test is not a devDependency");
	return version;
}

function job(): Job {
	const j = loadWorkflow().jobs?.["ui-visual"];
	if (j === undefined) throw new Error(`${WORKFLOW} has no ui-visual job`);
	return j;
}

describe("ui-visual workflow", () => {
	test("pins @playwright/test to an exact version the image tag can match", () => {
		expect(playwrightVersion()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("runs in the Playwright image matching the devDependency, pinned by digest", () => {
		const image = job().container?.image ?? "";
		const tag = `mcr.microsoft.com/playwright:v${playwrightVersion()}-noble`;
		expect(image.startsWith(`${tag}@sha256:`)).toBe(true);
		expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
	});

	test("keeps the ui-visual status check name stable for warren-dbef", () => {
		expect(job().name).toBe("ui-visual");
		expect(job()["timeout-minutes"]).toBeGreaterThan(0);
	});

	test("triggers on UI and harness changes, including the workflow itself", () => {
		const wf = loadWorkflow();
		expect(Object.keys(wf.on ?? {})).toContain("workflow_dispatch");
		for (const event of ["pull_request", "push"]) {
			const paths = wf.on?.[event]?.paths ?? [];
			expect(paths).toContain("src/ui/**");
			expect(paths).toContain("scripts/ui-visual/**");
			expect(paths).toContain(WORKFLOW);
		}
		expect(wf.concurrency?.group).toBeDefined();
	});

	test("runs check:ui-visual and uploads the output directory on every outcome", () => {
		const steps = job().steps ?? [];
		expect(steps.some((s) => s.run === "bun run check:ui-visual")).toBe(true);
		const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
		expect(upload?.if).toBe("always()");
		expect(upload?.with?.path).toBe("scripts/ui-visual/out/");
		expect(String(upload?.with?.name)).toStartWith("ui-screenshots-");
	});
});
