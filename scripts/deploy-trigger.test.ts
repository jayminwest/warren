import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

// Regression guard for warren-cb81: the release -> GKE deploy chain must not
// rely on a `release: [published]` event. Releases are cut with the default
// GITHUB_TOKEN, and GitHub suppresses workflow runs for GITHUB_TOKEN-created
// events, so a release-event trigger silently never fires. release.yml must
// instead invoke deploy-gke.yml directly (workflow_call), pinned to the
// released SHA.

const REPO_ROOT = resolve(import.meta.dir, "..");

// Assembled at runtime so the source has no stray GitHub Actions ${{ ... }}
// placeholder (Biome's noTemplateCurlyInString flags literal ones).
const SHA_EXPR = `\${{ github.sha }}`;

type Workflow = {
	on?: {
		workflow_call?: { inputs?: Record<string, { required?: boolean; type?: string }> };
		[key: string]: unknown;
	};
	jobs?: Record<string, { uses?: string; with?: Record<string, unknown>; needs?: unknown }>;
};

function loadWorkflow(name: string): Workflow {
	const raw = readFileSync(resolve(REPO_ROOT, ".github/workflows", name), "utf8");
	return load(raw) as Workflow;
}

describe("release -> GKE deploy trigger chain", () => {
	test("deploy-gke.yml does not trigger on release: published (suppressed GITHUB_TOKEN event)", () => {
		const wf = loadWorkflow("deploy-gke.yml");
		expect(wf.on).toBeDefined();
		expect(Object.keys(wf.on ?? {})).not.toContain("release");
	});

	test("deploy-gke.yml exposes a workflow_call entrypoint with a required sha input", () => {
		const wf = loadWorkflow("deploy-gke.yml");
		const call = wf.on?.workflow_call;
		expect(call).toBeDefined();
		const sha = call?.inputs?.sha;
		expect(sha).toBeDefined();
		expect(sha?.required).toBe(true);
		expect(sha?.type).toBe("string");
	});

	test("release.yml calls deploy-gke.yml directly, pinned to the released SHA", () => {
		const wf = loadWorkflow("release.yml");
		const deploy = wf.jobs?.deploy;
		expect(deploy).toBeDefined();
		expect(deploy?.uses).toBe("./.github/workflows/deploy-gke.yml");
		// Must pass the exact commit SHA and opt into the roll-forward.
		expect(deploy?.with?.sha).toBe(SHA_EXPR);
		expect(deploy?.with?.deploy).toBe(true);
		// The deploy must chain off the release job so it only runs on a real release.
		expect(deploy?.needs).toBe("release");
	});
});
