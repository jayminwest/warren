// Renders deploy/k8s/components/postgres with `kubectl kustomize` and asserts
// the seven objects come out: the four from warren-9f5a plus the backup layer
// from warren-6db7 (SA, ConfigMap, CronJob — the restore Job became a sed
// template in warren-a413 and is no longer a rendered resource). The 10Gi claim is a
// volumeClaimTemplate inside the StatefulSet, not a fifth top-level object.
//
// The component is opt-in: nothing in base includes it, so the render wraps it
// in a throwaway overlay the way an operator's gitignored live overlay would.
// kustomize refuses absolute paths and a Component must be pulled in through
// `components:`, so the throwaway overlay lives under deploy/k8s/overlays/ and
// references the component relatively. Skips cleanly when kubectl is absent —
// the guarantee it pins (the component renders) is enforced in CI and on any
// machine with kubectl, not in sandboxes without the binary.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAll } from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");
const OVERLAYS_DIR = join(REPO_ROOT, "deploy", "k8s", "overlays");
const KUBECTL_TIMEOUT_MS = 20_000;

function hasKubectl(): boolean {
	try {
		execFileSync("kubectl", ["version", "--client=true", "--output=yaml"], {
			stdio: "ignore",
			timeout: KUBECTL_TIMEOUT_MS,
		});
		return true;
	} catch {
		return false;
	}
}

const HAS_KUBECTL = hasKubectl();

interface K8sDoc {
	kind?: string;
	metadata?: { name?: string; namespace?: string };
}

/**
 * Render a throwaway overlay that pulls in the component. `resources` adds a
 * `resources:` list in front: `["../gke"]` is the live shape (the gke template
 * plus the component, as the operator's gke-live overlay has it).
 */
function renderComponent(resources: string[] = []): K8sDoc[] {
	const dir = mkdtempSync(join(OVERLAYS_DIR, "tmp-postgres-component-test-"));
	try {
		writeFileSync(
			join(dir, "kustomization.yaml"),
			[
				"apiVersion: kustomize.config.k8s.io/v1beta1",
				"kind: Kustomization",
				...(resources.length > 0 ? ["resources:", ...resources.map((r) => `  - ${r}`)] : []),
				"components:",
				"  - ../../components/postgres",
				"",
			].join("\n"),
		);
		const out = execFileSync("kubectl", ["kustomize", dir], {
			cwd: REPO_ROOT,
			maxBuffer: 10 * 1024 * 1024,
			timeout: KUBECTL_TIMEOUT_MS,
		}).toString();
		return loadAll(out) as K8sDoc[];
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("deploy/k8s/components/postgres", () => {
	test.skipIf(!HAS_KUBECTL)(
		"kubectl kustomize of an including overlay renders all seven objects",
		() => {
			const docs = renderComponent();
			const byName = (kind: string, name: string) =>
				docs.some((d) => d.kind === kind && d.metadata?.name === name);

			// Four database objects (warren-9f5a) + three backup objects (warren-6db7).
			// restore-job.template.yaml is a sed template, not a rendered resource
			// (warren-a413): Job pod templates are immutable, so a standing
			// postgres-restore Job cannot be parameterised with kubectl set env.
			expect(docs).toHaveLength(7);
			expect(byName("StatefulSet", "postgres")).toBeTrue();
			expect(byName("Service", "postgres")).toBeTrue();
			expect(byName("Secret", "postgres-credentials")).toBeTrue();
			expect(byName("NetworkPolicy", "postgres-ingress-from-control-plane")).toBeTrue();
			expect(byName("ServiceAccount", "postgres-backup")).toBeTrue();
			expect(byName("ConfigMap", "postgres-backup-config")).toBeTrue();
			expect(byName("CronJob", "postgres-backup")).toBeTrue();
			expect(byName("Job", "postgres-restore")).toBeFalse();
			for (const d of docs) {
				expect(d.metadata?.namespace).toBe("warren");
			}
		},
		{ timeout: 2 * KUBECTL_TIMEOUT_MS + 5_000 },
	);

	test.skipIf(!HAS_KUBECTL)(
		"backup CronJob runs pg_dump nightly with Forbid concurrency and the restore template ships placeholders",
		() => {
			const docs = renderComponent() as Array<Record<string, unknown>>;
			const cron = docs.find(
				(d) => d.kind === "CronJob" && (d.metadata as { name?: string }).name === "postgres-backup",
			) as {
				spec?: {
					schedule?: string;
					concurrencyPolicy?: string;
					successfulJobsHistoryLimit?: number;
					failedJobsHistoryLimit?: number;
					jobTemplate?: {
						spec?: {
							backoffLimit?: number;
							template?: { spec?: { serviceAccountName?: string } };
						};
					};
				};
			};
			expect(cron.spec?.schedule).toBe("0 3 * * *");
			expect(cron.spec?.concurrencyPolicy).toBe("Forbid");
			expect(cron.spec?.successfulJobsHistoryLimit).toBe(3);
			expect(cron.spec?.failedJobsHistoryLimit).toBe(3);
			expect(cron.spec?.jobTemplate?.spec?.backoffLimit).toBe(0);
			expect(cron.spec?.jobTemplate?.spec?.template?.spec?.serviceAccountName).toBe(
				"postgres-backup",
			);

			const sa = docs.find(
				(d) =>
					d.kind === "ServiceAccount" &&
					(d.metadata as { name?: string }).name === "postgres-backup",
			) as {
				metadata?: {
					annotations?: Record<string, string>;
				};
			};
			expect(sa.metadata?.annotations?.["iam.gke.io/gcp-service-account"]).toBe(
				"postgres-backup@warren-502318.iam.gserviceaccount.com",
			);
		},
		{ timeout: 2 * KUBECTL_TIMEOUT_MS + 5_000 },
	);

	test("restore-job.template.yaml renders a substitutable throwaway Job (warren-a413)", () => {
		const templatePath = join(
			REPO_ROOT,
			"deploy",
			"k8s",
			"components",
			"postgres",
			"backup",
			"restore-job.template.yaml",
		);
		const raw = readFileSync(templatePath, "utf8");
		expect(raw).toContain("__RESTORE_NAME__");
		expect(raw).toContain("__RESTORE_DUMP__");

		// The documented one-liner pipes sed output to kubectl create -f -.
		// Replay the sed substitution and parse the result; the same guarantee
		// (placeholders fully consumed, a valid Job spec) holds for sed and
		// envsubst alike.
		const rendered = raw
			.replaceAll("__RESTORE_NAME__", "postgres-restore-20260903")
			.replaceAll("__RESTORE_DUMP__", "20260903");
		expect(rendered).not.toContain("__RESTORE");

		const [job] = loadAll(rendered) as Array<{
			kind?: string;
			metadata?: { name?: string; namespace?: string };
			spec?: {
				backoffLimit?: number;
				template?: {
					spec?: {
						serviceAccountName?: string;
						initContainers?: Array<{
							name?: string;
							env?: Array<{ name?: string; value?: string }>;
						}>;
					};
				};
			};
		}>;
		expect(job).toBeDefined();
		if (!job) throw new Error("rendered restore Job missing");
		expect(job.kind).toBe("Job");
		expect(job.metadata?.name).toBe("postgres-restore-20260903");
		expect(job.metadata?.namespace).toBe("warren");
		expect(job.spec?.backoffLimit).toBe(0);
		expect(job.spec?.template?.spec?.serviceAccountName).toBe("postgres-backup");
		const fetch = job.spec?.template?.spec?.initContainers?.find((c) => c.name === "fetch");
		expect(fetch?.env?.find((e) => e.name === "RESTORE_DUMP")?.value).toBe("20260903");
	});
});

// Disruption protection (warren-a5d2). Autopilot scale-down evicted postgres-0
// twice in 36 minutes; each eviction was a 20-40s API outage. The StatefulSet
// and the control-plane Deployment carry safe-to-evict "false", and the gke
// overlay ships a zero-budget PDB for postgres. The PDB lives in the overlay
// rather than the component because deploy-gke.yml renders gke-live from
// ../gke only, so only an overlay resource reaches the cluster through CI.
const SAFE_TO_EVICT = "cluster-autoscaler.kubernetes.io/safe-to-evict";

interface PodTemplateDoc extends K8sDoc {
	spec?: {
		maxUnavailable?: number;
		unhealthyPodEvictionPolicy?: string;
		selector?: { matchLabels?: Record<string, string> };
		template?: {
			metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
		};
	};
}

function renderGkeOverlay(): PodTemplateDoc[] {
	const out = execFileSync("kubectl", ["kustomize", join(OVERLAYS_DIR, "gke")], {
		cwd: REPO_ROOT,
		maxBuffer: 10 * 1024 * 1024,
		timeout: KUBECTL_TIMEOUT_MS,
	}).toString();
	return loadAll(out) as PodTemplateDoc[];
}

function find(docs: PodTemplateDoc[], kind: string, name: string): PodTemplateDoc | undefined {
	return docs.find((d) => d.kind === kind && d.metadata?.name === name);
}

describe("postgres disruption protection (warren-a5d2)", () => {
	test.skipIf(!HAS_KUBECTL)(
		"the CI-rendered gke overlay carries the postgres PDB and a non-evictable control plane",
		() => {
			const docs = renderGkeOverlay();
			const pdb = find(docs, "PodDisruptionBudget", "postgres");
			expect(pdb?.metadata?.namespace).toBe("warren");
			expect(pdb?.spec?.maxUnavailable).toBe(0);
			expect(pdb?.spec?.unhealthyPodEvictionPolicy).toBe("AlwaysAllow");
			const warren = find(docs, "Deployment", "warren");
			expect(warren?.spec?.template?.metadata?.annotations?.[SAFE_TO_EVICT]).toBe("false");
		},
		{ timeout: KUBECTL_TIMEOUT_MS + 5_000 },
	);

	test.skipIf(!HAS_KUBECTL)(
		"in the live shape (gke + component) the PDB selects the non-evictable postgres pod",
		() => {
			const docs = renderComponent(["../gke"]) as PodTemplateDoc[];
			const sts = find(docs, "StatefulSet", "postgres");
			const template = sts?.spec?.template?.metadata;
			expect(template?.annotations?.[SAFE_TO_EVICT]).toBe("false");

			const pdbs = docs.filter((d) => d.kind === "PodDisruptionBudget");
			expect(pdbs).toHaveLength(1);
			const selector = pdbs[0]?.spec?.selector?.matchLabels ?? {};
			expect(Object.keys(selector).length).toBeGreaterThan(0);
			for (const [key, value] of Object.entries(selector)) {
				expect(template?.labels?.[key]).toBe(value);
			}
		},
		{ timeout: KUBECTL_TIMEOUT_MS + 5_000 },
	);
});
