// Renders deploy/k8s/components/postgres with `kubectl kustomize` and asserts
// all five objects come out (warren-9f5a, plan pl-6076).
//
// The component is opt-in: nothing in base includes it, so the render wraps it
// in a throwaway overlay kustomization (tmp dir) the way an operator's
// gitignored live overlay would. Skips cleanly when kubectl is absent — the
// guarantee it pins (the component renders) is enforced in CI and on any
// machine with kubectl, not in sandboxes without the binary.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAll } from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");
const COMPONENT = "deploy/k8s/components/postgres";

function hasKubectl(): boolean {
	try {
		execFileSync("kubectl", ["version", "--client=true", "--output=yaml"], {
			stdio: "ignore",
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
	const dir = mkdtempSync(join(tmpdir(), "warren-pg-component-"));
	try {
		writeFileSync(
			join(dir, "kustomization.yaml"),
			`resources:\n  - ${resolve(REPO_ROOT, COMPONENT)}\n`,
		);
		const out = execFileSync("kubectl", ["kustomize", dir], {
			cwd: REPO_ROOT,
			maxBuffer: 10 * 1024 * 1024,
		}).toString();
		return loadAll(out) as K8sDoc[];
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("deploy/k8s/components/postgres", () => {
	test("kubectl kustomize of an including overlay renders all five objects", () => {
		if (!hasKubectl()) {
			console.warn("kubectl not found — skipping kustomize render check");
			return;
		}
		const docs = renderComponent();
		const byName = (kind: string, name: string) =>
			docs.some((d) => d.kind === kind && d.metadata?.name === name);

		expect(docs).toHaveLength(5);
		expect(byName("StatefulSet", "postgres")).toBeTrue();
		expect(byName("Service", "postgres")).toBeTrue();
		expect(byName("Secret", "postgres-credentials")).toBeTrue();
		expect(byName("NetworkPolicy", "postgres-ingress-from-control-plane")).toBeTrue();
		for (const d of docs) {
			expect(d.metadata?.namespace).toBe("warren");
		}
	});
});
