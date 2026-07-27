import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { load } from "js-yaml";

// Guards for warren-26be: the control-plane image must be published to the
// public ghcr.io registry with semver tags, and docker-compose.yml must pull
// it rather than build from source. Without this the "one container,
// five-minute self-host" claim is false — a fresh clone had to build.
//
// Workflows can't run locally, so these assert on the parsed YAML, plus one
// test that actually executes the tag-computation shell the workflow embeds.

const REPO_ROOT = resolve(import.meta.dir, "..");

// Assembled at runtime so the source has no stray GitHub Actions ${{ ... }}
// placeholder (Biome's noTemplateCurlyInString flags literal ones).
const VERSION_OUTPUT_EXPR = `\${{ needs.release.outputs.version }}`;
const GHCR_TAGS_EXPR = `\${{ steps.ghcr-tags.outputs.tags }}`;
const GHCR_IMAGE_EXPR = `ghcr.io/\${{ github.repository_owner }}/warren`;
const ACTOR_EXPR = `\${{ github.actor }}`;
const GITHUB_TOKEN_EXPR = `\${{ secrets.GITHUB_TOKEN }}`;

type Step = {
	name?: string;
	id?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
};

type Workflow = {
	env?: Record<string, string>;
	on?: {
		workflow_call?: { inputs?: Record<string, { required?: boolean; type?: string }> };
		[key: string]: unknown;
	};
	jobs?: Record<
		string,
		{
			permissions?: Record<string, string>;
			steps?: Step[];
			uses?: string;
			with?: Record<string, unknown>;
		}
	>;
};

function loadWorkflow(name: string): Workflow {
	const raw = readFileSync(resolve(REPO_ROOT, ".github/workflows", name), "utf8");
	return load(raw) as Workflow;
}

function buildPushSteps(): Step[] {
	const wf = loadWorkflow("deploy-gke.yml");
	return wf.jobs?.["build-push"]?.steps ?? [];
}

/** The `tags:` block of a build-push-action step, one tag per line. */
function tagsOf(steps: readonly Step[], stepName: string): string[] {
	const step = steps.find((s) => s.name === stepName);
	if (step === undefined) throw new Error(`no step named ${stepName}`);
	const tags = step.with?.tags;
	if (typeof tags !== "string") throw new Error(`step ${stepName} has no string tags`);
	return tags
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

describe("ghcr.io control-plane publish (deploy-gke.yml)", () => {
	test("workflow_call takes an optional version input for the semver tags", () => {
		const call = loadWorkflow("deploy-gke.yml").on?.workflow_call;
		const version = call?.inputs?.version;
		expect(version).toBeDefined();
		expect(version?.type).toBe("string");
		// Optional: push + dispatch builds have no released version, and must
		// still publish the SHA and latest tags.
		expect(version?.required).not.toBe(true);
	});

	test("build-push holds packages: write and logs into ghcr.io with GITHUB_TOKEN", () => {
		const job = loadWorkflow("deploy-gke.yml").jobs?.["build-push"];
		expect(job?.permissions?.packages).toBe("write");
		const login = (job?.steps ?? []).find(
			(s) => s.uses?.startsWith("docker/login-action") && s.with?.registry === "ghcr.io",
		);
		expect(login).toBeDefined();
		// No new secret to provision — the job's own GITHUB_TOKEN is enough.
		expect(login?.with?.username).toBe(ACTOR_EXPR);
		expect(login?.with?.password).toBe(GITHUB_TOKEN_EXPR);
	});

	test("GHCR_IMAGE resolves under the repository owner, not a hardcoded namespace", () => {
		expect(loadWorkflow("deploy-gke.yml").env?.GHCR_IMAGE).toBe(GHCR_IMAGE_EXPR);
	});

	test("only the control-plane image carries the ghcr.io tag set", () => {
		const steps = buildPushSteps();
		expect(tagsOf(steps, "Build + push warren (control plane)")).toContain(GHCR_TAGS_EXPR);
		// warren-agent and warren-workspace-init only ever run on GKE; they stay
		// in the private Artifact Registry.
		for (const name of ["Build + push warren-agent", "Build + push warren-workspace-init"]) {
			for (const tag of tagsOf(steps, name)) {
				expect(tag).not.toContain("ghcr.io");
			}
		}
	});

	test("the control plane keeps its Artifact Registry tags alongside ghcr.io", () => {
		const tags = tagsOf(buildPushSteps(), "Build + push warren (control plane)");
		expect(tags.filter((t) => t.includes("AR_BASE")).length).toBe(2);
	});
});

/**
 * Run the workflow's embedded tag-computation shell for one version input and
 * return the tags it wrote to $GITHUB_OUTPUT. Extracting the script from the
 * YAML (rather than restating it) means the assertions can't drift from what
 * the workflow actually executes.
 */
function computeTags(version: string): string[] {
	const step = buildPushSteps().find((s) => s.id === "ghcr-tags");
	if (step?.run === undefined) throw new Error("no ghcr-tags step with a run script");

	const dir = mkdtempSync(join(tmpdir(), "warren-ghcr-tags-"));
	try {
		const outputPath = join(dir, "github-output");
		Bun.write(outputPath, "");
		const result = Bun.spawnSync({
			cmd: ["bash", "-c", step.run],
			env: {
				PATH: process.env.PATH ?? "",
				GHCR_IMAGE: "ghcr.io/jayminwest/warren",
				SHA: "abc123",
				VERSION: version,
				GITHUB_OUTPUT: outputPath,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const written = readFileSync(outputPath, "utf8").trim().split("\n");
		// Strip the `tags<<DELIM` header and the closing delimiter.
		return written.slice(1, -1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("ghcr.io tag computation", () => {
	test("a versionless build publishes only the SHA and latest", () => {
		expect(computeTags("")).toEqual([
			"ghcr.io/jayminwest/warren:abc123",
			"ghcr.io/jayminwest/warren:latest",
		]);
	});

	test("a release publishes the SHA, latest, vX.Y.Z and the moving X.Y", () => {
		expect(computeTags("0.11.2")).toEqual([
			"ghcr.io/jayminwest/warren:abc123",
			"ghcr.io/jayminwest/warren:latest",
			"ghcr.io/jayminwest/warren:v0.11.2",
			"ghcr.io/jayminwest/warren:0.11",
		]);
	});

	test("a prerelease gets its exact tag but never the moving minor tag", () => {
		expect(computeTags("0.12.0-rc.1")).toEqual([
			"ghcr.io/jayminwest/warren:abc123",
			"ghcr.io/jayminwest/warren:latest",
			"ghcr.io/jayminwest/warren:v0.12.0-rc.1",
		]);
	});
});

describe("release.yml threads the released version through workflow_call", () => {
	test("the deploy job passes version and grants packages: write", () => {
		const deploy = loadWorkflow("release.yml").jobs?.deploy;
		expect(deploy?.uses).toBe("./.github/workflows/deploy-gke.yml");
		expect(deploy?.with?.version).toBe(VERSION_OUTPUT_EXPR);
		// A called workflow can only use permissions the caller granted.
		expect(deploy?.permissions?.packages).toBe("write");
	});
});

describe("docker-compose.yml pulls the published image", () => {
	const raw = readFileSync(resolve(REPO_ROOT, "docker-compose.yml"), "utf8");
	const parsed = load(raw) as {
		services?: Record<string, { image?: string; build?: unknown }>;
	};

	test("the warren service names the ghcr.io image with an overridable tag", () => {
		const image = parsed.services?.warren?.image ?? "";
		expect(image.startsWith("ghcr.io/jayminwest/warren:")).toBe(true);
		// Self-hosters pin a release without editing the file.
		expect(image).toContain("WARREN_IMAGE_TAG");
	});

	test("no active build block — a fresh clone pulls rather than builds", () => {
		expect(parsed.services?.warren?.build).toBeUndefined();
		// The fallback stays in the file, commented, for contributors.
		expect(raw).toContain("# build:");
		expect(raw).toContain("#   dockerfile: Dockerfile");
	});
});
