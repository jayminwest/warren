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
// release.yml resolves the released commit itself (warren-a8e6): github.sha on a
// draft-resume dispatch is whatever main is now, not what the tag names.
const SHA_EXPR = `\${{ needs.release.outputs.release_sha }}`;
// Shell (not Actions) interpolation, but the same lint rule applies.
const NEW_NAME_EXPR = `newName: \${AR_BASE}/warren`;

type Step = {
	name?: string;
	id?: string;
	run?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
};

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

// warren-5ca2: the v0.18.0 release failed its deploy three times on
// `kubectl apply -k` when a bursty GKE API server answered InternalError for a
// different handful of resources each pass. The step now renders once and
// applies each resource on its own with a bounded per-resource retry, so the
// overlay converges without ever needing one pass where every GET succeeds.
// Run the real step script against a stub kubectl to prove the shape.
function runApplyOverlay(opts: {
	/** per-resource failure counts before success; -1 = never succeeds */
	failures: Record<string, number>;
	attempts: number;
}): { exitCode: number; output: string; applied: string[] } {
	const script = stepScript("deploy", "Apply overlay");
	const dir = mkdtempSync(join(tmpdir(), "warren-apply-overlay-"));
	try {
		const bin = join(dir, "bin");
		const state = join(dir, "state");
		Bun.spawnSync({ cmd: ["mkdir", "-p", bin, state] });
		writeFileSync(join(state, "failures.json"), JSON.stringify(opts.failures));
		// Stub kubectl: `kustomize -o DIR` writes three rendered files (a
		// namespace and two namespaced objects); `apply -f FILE` consults the
		// per-resource failure budget and appends to an apply log on success.
		// The budget is decremented with `bun -e`, not `node -e`: the oven/bun
		// image has no Node, and its `node` wrapper drops the first argument,
		// which silently made every apply look like a failure.
		const stub = join(bin, "kubectl");
		writeFileSync(
			stub,
			[
				"#!/usr/bin/env bash",
				'case "$1" in',
				"  kustomize)",
				`    out="\${@: -1}"`,
				"    for r in warren_apps_v1_deployment_warren v1_namespace_warren warren_v1_service_warren; do",
				`      echo "kind: stub" > "\${out}/\${r}.yaml"`,
				"    done ;;",
				"  apply)",
				'    name=$(basename "$3" .yaml)',
				`    left=$(bun -e 'const f=require(process.argv[1]);const n=f[process.argv[2]]??0;if(n!==0&&n!==-1)f[process.argv[2]]=n-1;require("fs").writeFileSync(process.argv[1],JSON.stringify(f));console.log(n)' "${state}/failures.json" "$name")`,
				'    if [ "$left" != "0" ]; then echo "Error from server (InternalError): $name" >&2; exit 1; fi',
				`    echo "$name" >> "${state}/applied"`,
				'    echo "$name configured" ;;',
				"  *) exit 99 ;;",
				"esac",
			].join("\n"),
		);
		chmodSync(stub, 0o755);
		const result = Bun.spawnSync({
			cmd: ["bash", "-c", script],
			cwd: dir,
			env: {
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				RUNNER_TEMP: dir,
				APPLY_ATTEMPTS: String(opts.attempts),
				APPLY_RETRY_SECONDS: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		let applied: string[] = [];
		try {
			applied = readFileSync(join(state, "applied"), "utf8").trim().split("\n");
		} catch {
			applied = [];
		}
		return {
			exitCode: result.exitCode,
			output: `${result.stdout.toString()}${result.stderr.toString()}`,
			applied,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("gke-live overlay apply converges per resource", () => {
	test("a resource that fails transiently is retried on its own until it lands", () => {
		const r = runApplyOverlay({ failures: { warren_v1_service_warren: 2 }, attempts: 4 });
		expect(r.exitCode).toBe(0);
		// Namespaces first, then every other resource exactly once.
		expect(r.applied).toEqual([
			"v1_namespace_warren",
			"warren_apps_v1_deployment_warren",
			"warren_v1_service_warren",
		]);
		expect(r.output).toContain("warren_v1_service_warren: attempt 3/4");
	});

	test("a resource that never converges is fatal after the budget, after the rest applied", () => {
		const r = runApplyOverlay({ failures: { warren_apps_v1_deployment_warren: -1 }, attempts: 3 });
		expect(r.exitCode).toBe(1);
		expect(r.output).toContain(
			"::error::kubectl apply warren_apps_v1_deployment_warren failed after 3 attempts",
		);
		expect(r.output).toContain("::error::1 resource(s) failed to apply");
		// The failure did not stop the service from converging.
		expect(r.applied).toEqual(["v1_namespace_warren", "warren_v1_service_warren"]);
	});

	test("a render failure is fatal before anything is applied", () => {
		const script = stepScript("deploy", "Apply overlay");
		expect(script).toContain("kubectl kustomize deploy/k8s/overlays/gke-live -o");
		expect(script).toContain("|| exit 1");
	});
});

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

// Assembled at runtime for the same noTemplateCurlyInString reason as SHA_EXPR.
const TARGET_SHA_EXPR = `\${{ env.TARGET_SHA }}`;

/**
 * Execute the judge-roll shell against a stubbed `kubectl`, so the assertions
 * exercise what the workflow really runs rather than a restatement of it.
 */
function runJudgeRoll(opts: {
	/** Whether `kubectl get deploy/judge` finds a judge Deployment. */
	deployed: boolean;
	/** Image the stubbed post-roll jsonpath read reports. */
	liveImage?: string;
}): { exitCode: number; output: string } {
	const script = stepScript("deploy", "Roll judge extension deployment");
	const dir = mkdtempSync(join(tmpdir(), "warren-judge-roll-"));
	try {
		const stub = join(dir, "kubectl");
		// Case order matters: the jsonpath read also matches `get deploy/judge`.
		writeFileSync(
			stub,
			[
				"#!/bin/sh",
				'case "$*" in',
				"  *jsonpath*) printf '%s' \"$STUB_LIVE_IMAGE\" ;;",
				'  *"set image"*|*"rollout status"*) exit 0 ;;',
				'  *"get deploy/judge"*) exit "$STUB_GET_EXIT" ;;',
				"esac",
				"exit 0",
			].join("\n"),
		);
		chmodSync(stub, 0o755);
		const result = Bun.spawnSync({
			cmd: ["bash", "-c", script],
			env: {
				PATH: `${dir}:${process.env.PATH ?? ""}`,
				AR_BASE: "us-west1-docker.pkg.dev/example/warren",
				SHA: "cafebabe",
				STUB_GET_EXIT: opts.deployed ? "0" : "1",
				STUB_LIVE_IMAGE: opts.liveImage ?? "",
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

describe("judge extension image build + roll (warren-eecb)", () => {
	test("build-push builds warren-ext-judge from the extension directory alone", () => {
		const steps = loadWorkflow("deploy-gke.yml").jobs?.["build-push"]?.steps ?? [];
		const step = steps.find((s) => s.name?.startsWith("Build + push warren-ext-judge"));
		expect(step).toBeDefined();
		// The build context is the package (docs/design/extensions.md §2) —
		// nothing outside extensions/judge/ may be referenced.
		expect(step?.with?.context).toBe("extensions/judge");
		expect(String(step?.with?.tags)).toContain(`/warren-ext-judge:${TARGET_SHA_EXPR}`);
	});

	test("skips cleanly when no judge Deployment exists (opt-in extension)", () => {
		const r = runJudgeRoll({ deployed: false });
		expect(r.exitCode).toBe(0);
		expect(r.output).toContain("skipping");
	});

	test("rolls and verifies when the live image matches the built SHA", () => {
		const r = runJudgeRoll({
			deployed: true,
			liveImage: "us-west1-docker.pkg.dev/example/warren/warren-ext-judge:cafebabe",
		});
		expect(r.exitCode).toBe(0);
		expect(r.output).toContain("Verified: judge deployment is running cafebabe");
	});

	test("fails loudly when the rolled-out image does not match", () => {
		const r = runJudgeRoll({
			deployed: true,
			liveImage: "us-west1-docker.pkg.dev/example/warren/warren-ext-judge:stale",
		});
		expect(r.exitCode).toBe(1);
		expect(r.output).toContain("::error::");
		expect(r.output).toContain("stale");
	});
});
