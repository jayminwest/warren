import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { load } from "js-yaml";

// Regression guard for warren-cb81: the release -> GKE deploy chain must not
// rely on a `release: [published]` event. Releases are cut with the default
// GITHUB_TOKEN, and GitHub suppresses workflow runs for GITHUB_TOKEN-created
// events, so a release-event trigger silently never fires. release.yml must
// instead invoke deploy-gke.yml directly (workflow_call), pinned to the
// released SHA.
//
// warren-8b5f extends the same guard to the rest of the trigger surface:
// deploy-gke.yml must have exactly one automatic entrypoint (workflow_call),
// no branch may deploy on its own, and the post-deploy /version smoke test
// must actually fail on a mismatch.

const REPO_ROOT = resolve(import.meta.dir, "..");

// Assembled at runtime so the source has no stray GitHub Actions ${{ ... }}
// placeholder (Biome's noTemplateCurlyInString flags literal ones).
const SHA_EXPR = `\${{ github.sha }}`;
// Shell (not Actions) interpolation, but the same lint rule applies.
const NEW_NAME_EXPR = `newName: \${AR_BASE}/warren`;

type Step = { name?: string; id?: string; run?: string; env?: Record<string, string> };

type Workflow = {
	on?: {
		workflow_call?: { inputs?: Record<string, { required?: boolean; type?: string }> };
		[key: string]: unknown;
	};
	jobs?: Record<
		string,
		{ uses?: string; with?: Record<string, unknown>; needs?: unknown; if?: unknown; steps?: Step[] }
	>;
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

describe("deploy-gke.yml builds once per release (warren-8b5f)", () => {
	test("no push trigger — release.yml is the only automatic builder", () => {
		const wf = loadWorkflow("deploy-gke.yml");
		// A `push: main` trigger built the images, and the release that same
		// push kicks off called this workflow again: two builds per release,
		// serialized by the gke-build-deploy concurrency group.
		expect(Object.keys(wf.on ?? {})).not.toContain("push");
		// Manual dispatch stays as the break-glass entrypoint.
		expect(Object.keys(wf.on ?? {})).toContain("workflow_dispatch");
	});

	test("no branch deploys by itself — the deploy job gates only on inputs.deploy", () => {
		const deploy = loadWorkflow("deploy-gke.yml").jobs?.deploy;
		expect(deploy?.if).toBe("inputs.deploy");
	});

	test("the k8s-migration branch cannot reach the cluster", () => {
		// That branch merged in v0.10.0; until warren-8b5f, pushing it deployed
		// prod. Assert on the parsed workflow so the header comment explaining
		// the removal doesn't satisfy its own guard.
		const wf = JSON.stringify(loadWorkflow("deploy-gke.yml"));
		expect(wf).not.toContain("k8s-migration");
	});
});

/** The `run` script of a named step in a deploy-gke.yml job. */
function stepScript(job: string, stepName: string): string {
	const step = (loadWorkflow("deploy-gke.yml").jobs?.[job]?.steps ?? []).find((s) =>
		s.name?.startsWith(stepName),
	);
	if (step?.run === undefined) throw new Error(`no step "${stepName}" with a run script`);
	return step.run;
}

describe("gke-live overlay image remap", () => {
	test("the kustomize match key equals the committed gke template's newName", () => {
		// The match key is the TEMPLATE's placeholder image name, not
		// vars.GCP_AR_REPO — the operator's repo only appears in newName (via
		// AR_BASE). If the template's newName ever drifts, the remap silently
		// no-ops and the deploy rolls out the placeholder registry path.
		const template = load(
			readFileSync(resolve(REPO_ROOT, "deploy/k8s/overlays/gke/kustomization.yaml"), "utf8"),
		) as { images?: { newName?: string }[] };
		const newName = template.images?.[0]?.newName;
		expect(newName).toBeDefined();
		expect(stepScript("deploy", "Render gke-live overlay")).toContain(`- name: ${newName}`);
	});

	test("newName is derived from AR_BASE so GCP_AR_REPO is honoured", () => {
		expect(stepScript("deploy", "Render gke-live overlay")).toContain(NEW_NAME_EXPR);
	});
});

/**
 * Execute the workflow's embedded /version smoke-test shell against a stubbed
 * `curl`, so the assertions exercise what the workflow really runs rather than
 * a restatement of it.
 */
function runSmokeTest(opts: {
	version: string;
	host: string;
	/** Body the stub `curl` prints; empty string means it fails like an unreachable host. */
	body: string;
}): { exitCode: number; output: string } {
	const script = stepScript("deploy", "Smoke-test /version");
	const dir = mkdtempSync(join(tmpdir(), "warren-version-smoke-"));
	try {
		const stub = join(dir, "curl");
		writeFileSync(
			stub,
			opts.body === "" ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\ncat <<'EOF'\n${opts.body}\nEOF\n`,
		);
		chmodSync(stub, 0o755);
		const result = Bun.spawnSync({
			cmd: ["bash", "-c", script],
			env: {
				PATH: `${dir}:${process.env.PATH ?? ""}`,
				VERSION: opts.version,
				INGRESS_HOST: opts.host,
				SMOKE_ATTEMPTS: "2",
				SMOKE_INTERVAL: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			exitCode: result.exitCode,
			output: `${result.stdout.toString()}${result.stderr.toString()}`,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("post-deploy /version smoke test", () => {
	test("passes when the ingress reports the released semver", () => {
		const r = runSmokeTest({
			version: "0.11.0",
			host: "warren.example",
			body: '{"version":"0.11.0"}',
		});
		expect(r.exitCode).toBe(0);
		expect(r.output).toContain("https://warren.example/version reports v0.11.0");
	});

	test("fails when the ingress still serves the previous version", () => {
		const r = runSmokeTest({
			version: "0.11.0",
			host: "warren.example",
			body: '{"version":"0.10.3"}',
		});
		expect(r.exitCode).toBe(1);
		expect(r.output).toContain("::error::");
		expect(r.output).toContain("0.10.3");
	});

	test("fails when the ingress never answers", () => {
		const r = runSmokeTest({ version: "0.11.0", host: "warren.example", body: "" });
		expect(r.exitCode).toBe(1);
		expect(r.output).toContain("::error::");
	});

	test("fails loudly rather than skipping when the ingress host is unconfigured", () => {
		const r = runSmokeTest({ version: "0.11.0", host: "", body: '{"version":"0.11.0"}' });
		expect(r.exitCode).toBe(1);
		expect(r.output).toContain("WARREN_INGRESS_HOST is unset");
	});

	test("a versionless build-only dispatch has nothing to assert and passes", () => {
		const r = runSmokeTest({ version: "", host: "", body: "" });
		expect(r.exitCode).toBe(0);
	});
});
