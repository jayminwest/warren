import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { load } from "js-yaml";

// Guards the edge abuse-control wiring for the GKE Ingress (warren-48d3).
//
// The Cloud Armor policy is a GCP *project* resource, so the repo holds two
// halves that must agree and neither compiler nor kustomize can check:
// `deploy/gcp/cloud-armor.sh` (the rule set) and
// `deploy/k8s/overlays/gke/backendconfig.yaml` (the attachment). A rename or a
// dropped annotation on either side silently ships an unprotected ingress —
// `kubectl apply` succeeds, the policy is just never enforced.

const REPO_ROOT = resolve(import.meta.dir, "..");
const OVERLAY = "deploy/k8s/overlays/gke";
const SCRIPT = "deploy/gcp/cloud-armor.sh";

function readRepoFile(path: string): string {
	return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

type BackendConfig = {
	apiVersion?: string;
	metadata?: { name?: string; namespace?: string };
	spec?: {
		securityPolicy?: { name?: string };
		timeoutSec?: number;
		logging?: { enable?: boolean };
	};
};

type Kustomization = {
	resources?: string[];
	patches?: { target?: { kind?: string; name?: string }; patch?: string }[];
};

function backendConfig(): BackendConfig {
	return load(readRepoFile(`${OVERLAY}/backendconfig.yaml`)) as BackendConfig;
}

function overlay(): Kustomization {
	return load(readRepoFile(`${OVERLAY}/kustomization.yaml`)) as Kustomization;
}

/** The gke overlay's inline patch for a given resource kind + name. */
function overlayPatch(kind: string, name: string): string {
	const patch = (overlay().patches ?? []).find(
		(p) => p.target?.kind === kind && p.target?.name === name,
	)?.patch;
	if (patch === undefined) throw new Error(`no gke overlay patch targeting ${kind}/${name}`);
	return patch;
}

/**
 * Run the provisioning script in `--dry-run` mode and return the gcloud
 * command lines it would execute. A stub `gcloud` that always fails is put on
 * PATH first, so a dry run that actually reaches GCP aborts under `set -e`
 * instead of quietly passing.
 */
function dryRunCommands(): string[] {
	const dir = mkdtempSync(join(tmpdir(), "warren-cloud-armor-"));
	try {
		const stub = join(dir, "gcloud");
		writeFileSync(stub, "#!/bin/sh\necho 'stub gcloud invoked' >&2\nexit 1\n");
		chmodSync(stub, 0o755);
		const result = Bun.spawnSync({
			cmd: [resolve(REPO_ROOT, SCRIPT), "--dry-run"],
			cwd: REPO_ROOT,
			// Stub dir first so it shadows any real gcloud; the rest is the
			// minimum needed for `#!/usr/bin/env bash` to resolve.
			env: { PATH: `${dir}:/usr/bin:/bin` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = result.stderr.toString();
		if (result.exitCode !== 0) throw new Error(`--dry-run exited ${result.exitCode}: ${stderr}`);
		expect(stderr).not.toContain("stub gcloud invoked");
		return result.stdout
			.toString()
			.split("\n")
			.filter((line) => line.startsWith("+ gcloud"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The single dry-run line creating the rule at `priority`. */
function ruleLine(commands: string[], priority: number): string {
	const matches = commands.filter((line) => line.includes(`rules create ${priority} `));
	expect(matches).toHaveLength(1);
	return matches[0] as string;
}

describe("BackendConfig attaches Cloud Armor to the GCE Ingress backend", () => {
	test("the overlay renders backendconfig.yaml", () => {
		expect(overlay().resources).toContain("backendconfig.yaml");
	});

	test("the Service annotation names the BackendConfig — the only thing that binds them", () => {
		const bc = backendConfig();
		expect(bc.apiVersion).toBe("cloud.google.com/v1");
		expect(bc.metadata?.namespace).toBe("warren");
		// Without this annotation the BackendConfig object applies cleanly and
		// is simply ignored by the GCE Ingress controller.
		expect(overlayPatch("Service", "warren")).toContain(
			`cloud.google.com/backend-config: '{"default": "${bc.metadata?.name}"}'`,
		);
	});

	test("the referenced policy is the one cloud-armor.sh provisions", () => {
		const policy = backendConfig().spec?.securityPolicy?.name;
		expect(policy).toBeTruthy();
		const commands = dryRunCommands();
		// The policy itself, plus every rule, must name it — a rename on either
		// side detaches the policy without any error anywhere.
		expect(
			commands.filter((l) => l.startsWith(`+ gcloud compute security-policies create ${policy} `)),
		).toHaveLength(1);
		for (const line of commands.filter((l) => l.includes(" rules "))) {
			expect(line).toContain(`--security-policy=${policy}`);
		}
	});

	test("the backend timeout outlives a long NDJSON event stream", () => {
		// GCE defaults backend services to 30s. Event streams
		// (GET /runs/:id/events) are unbounded by default
		// (WARREN_EVENT_STREAM_MAX_LIFETIME=0), so the default would sever every
		// UI stream watching a run longer than half a minute.
		expect(backendConfig().spec?.timeoutSec ?? 0).toBeGreaterThanOrEqual(3600);
	});

	test("LB request logging is on, or Cloud Armor decisions are invisible", () => {
		expect(backendConfig().spec?.logging?.enable).toBe(true);
	});
});

describe("cloud-armor.sh rule set", () => {
	test("per-IP rate limiting bans the offender rather than throttling per request", () => {
		const rule = ruleLine(dryRunCommands(), 1000);
		expect(rule).toContain("--action=rate-based-ban");
		expect(rule).toContain("--conform-action=allow");
		expect(rule).toContain("--exceed-action=deny-429");
		expect(rule).toContain("--ban-duration-sec=");
		expect(rule).toContain("--rate-limit-threshold-count=");
		expect(rule).toContain("--rate-limit-threshold-interval-sec=");
		// Cloudflare must stay DNS-only for ManagedCertificate validation
		// (managedcertificate.yaml), so the connecting IP is the real client. Behind
		// a proxy this key would collapse every caller onto the proxy's address.
		expect(rule).toContain("--enforce-on-key=IP");
		expect(rule).toContain("--src-ip-ranges=*");
	});

	test("payload WAF signatures stay in preview — warren prompts contain SQL, shell and HTML", () => {
		const commands = dryRunCommands();
		for (const signature of ["sqli", "xss", "rce", "lfi"]) {
			const matches = commands.filter((line) => line.includes(`'${signature}-v33-stable'`));
			expect(matches).toHaveLength(1);
			// Enforcing any of these blocks legitimate dispatches: a prompt saying
			// "drop table users" is a valid request to warren.
			expect(matches[0]).toContain("--preview");
		}
	});

	test("only framing/caller signatures are enforced, at the lowest sensitivity", () => {
		const commands = dryRunCommands();
		for (const [priority, signature] of [
			[2000, "protocolattack-v33-stable"],
			[2100, "scannerdetection-v33-stable"],
		] as const) {
			const rule = ruleLine(commands, priority);
			expect(rule).toContain(`'${signature}'`);
			expect(rule).toContain("{'sensitivity': 1}");
			expect(rule).toContain("--action=deny-403");
			expect(rule).not.toContain("--preview");
		}
	});

	test("thresholds are env-overridable so a banned NAT egress IP can be widened", () => {
		expect(readRepoFile(SCRIPT)).toContain("WARREN_ARMOR_RATE_LIMIT_COUNT");
		expect(readRepoFile(SCRIPT)).toContain("WARREN_ARMOR_BAN_DURATION_SEC");
	});

	test("applying without a project id fails instead of guessing", () => {
		const result = Bun.spawnSync({
			cmd: [resolve(REPO_ROOT, SCRIPT)],
			cwd: REPO_ROOT,
			env: { PATH: process.env.PATH ?? "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("PROJECT_ID");
	});
});

describe("runbook documents the policy", () => {
	test("thresholds, kill switch and budget alerting are all written down", () => {
		const runbook = readRepoFile("docs/RUNBOOK-K8S.md");
		expect(runbook).toContain(SCRIPT);
		expect(runbook).toContain(backendConfig().spec?.securityPolicy?.name ?? "");
		expect(runbook).toContain("Kill switch");
		expect(runbook).toContain("budgets create");
	});
});
