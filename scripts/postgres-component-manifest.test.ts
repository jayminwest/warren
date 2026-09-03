// Renders deploy/k8s/components/postgres with `kubectl kustomize` and asserts
// the four objects come out (warren-9f5a, plan pl-6076). The 10Gi claim is a
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

interface K8sDoc {
	kind?: string;
	metadata?: { name?: string; namespace?: string };
}

function renderComponent(): K8sDoc[] {
	const dir = mkdtempSync(join(OVERLAYS_DIR, "tmp-postgres-component-test-"));
	try {
		writeFileSync(
			join(dir, "kustomization.yaml"),
			[
				"apiVersion: kustomize.config.k8s.io/v1beta1",
				"kind: Kustomization",
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
	test(
		"kubectl kustomize of an including overlay renders all four objects",
		() => {
			if (!hasKubectl()) {
				console.warn("kubectl not found — skipping kustomize render check");
				return;
			}
			const docs = renderComponent();
			const byName = (kind: string, name: string) =>
				docs.some((d) => d.kind === kind && d.metadata?.name === name);

			expect(docs).toHaveLength(4);
			expect(byName("StatefulSet", "postgres")).toBeTrue();
			expect(byName("Service", "postgres")).toBeTrue();
			expect(byName("Secret", "postgres-credentials")).toBeTrue();
			expect(byName("NetworkPolicy", "postgres-ingress-from-control-plane")).toBeTrue();
			for (const d of docs) {
				expect(d.metadata?.namespace).toBe("warren");
			}
		},
		{ timeout: 2 * KUBECTL_TIMEOUT_MS + 5_000 },
	);
});
