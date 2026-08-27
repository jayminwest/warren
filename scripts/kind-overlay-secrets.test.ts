// Guards the kind overlay's placeholder-Secret exclusion (warren-df5c).
//
// base/secrets.yaml ships REPLACE_ME templates so `kustomize build` resolves.
// The kind overlay (docs/RUNBOOK-K8S.md §1.3) is what a local dev cluster
// applies — if it ever renders those templates, `kubectl apply` installs
// Secrets whose values are literally "REPLACE_ME" (or clobbers real ones
// created imperatively), and the failure surfaces only at runtime with a
// 401 / bad credential from inside the cluster.
//
// The render below is a minimal kustomize: it resolves the overlay's
// `resources: ../../base`, concatenates the base documents, then applies the
// overlay's `$patch: delete` targets. For the property under test (do the
// placeholder Secrets survive the render?) that is faithful to
// `kustomize build` — deletion is the only patch kind that removes a resource.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadAll } from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");
const KIND_OVERLAY = "deploy/k8s/overlays/kind/kustomization.yaml";

interface PatchTarget {
	kind?: string;
	name?: string;
}

interface Kustomization {
	resources?: string[];
	patches?: Array<{ target?: PatchTarget; patch?: string }>;
}

interface K8sDoc {
	kind?: string;
	metadata?: { name?: string; namespace?: string };
	[key: string]: unknown;
}

function readYamlDocs(path: string): K8sDoc[] {
	const raw = readFileSync(resolve(REPO_ROOT, path), "utf8");
	return loadAll(raw) as K8sDoc[];
}

function loadYaml<T>(path: string): T {
	return loadAll(readFileSync(resolve(REPO_ROOT, path), "utf8"))[0] as T;
}

/** Minimal kustomize render: base resources minus the overlay's
 *  `$patch: delete` targets. */
function renderKindOverlay(): K8sDoc[] {
	const overlay = loadYaml<Kustomization>(KIND_OVERLAY);
	const overlayDir = dirname(resolve(REPO_ROOT, KIND_OVERLAY));

	const baseRel = overlay.resources?.[0];
	if (!baseRel?.endsWith("base")) {
		throw new Error("kind overlay must build on ../../base");
	}
	const baseDir = resolve(overlayDir, baseRel);
	const base = loadYaml<Kustomization>(
		resolve(baseDir, "kustomization.yaml").slice(REPO_ROOT.length + 1),
	);

	const docs: K8sDoc[] = [];
	for (const res of base.resources ?? []) {
		docs.push(...readYamlDocs(resolve(baseDir, res).slice(REPO_ROOT.length + 1)));
	}

	const deletes = (overlay.patches ?? []).filter((p) => (p.patch ?? "").includes("$patch: delete"));
	return docs.filter(
		(doc) =>
			!deletes.some((p) => p.target?.kind === doc.kind && p.target?.name === doc.metadata?.name),
	);
}

describe("kind overlay placeholder-Secret exclusion (warren-df5c)", () => {
	test("renders without any REPLACE_ME placeholder value", () => {
		const rendered = JSON.stringify(renderKindOverlay());
		expect(rendered).not.toContain("REPLACE_ME");
	});

	test("renders zero Secret objects at all", () => {
		const secrets = renderKindOverlay().filter((d) => d.kind === "Secret");
		expect(secrets).toEqual([]);
	});

	test("the guard is live: base secrets.yaml still carries REPLACE_ME", () => {
		// If the templates are ever deleted upstream this test would pass
		// vacuously — pin that the placeholder source still exists so the
		// exclusion above is doing real work.
		const raw = readFileSync(resolve(REPO_ROOT, "deploy/k8s/base/secrets.yaml"), "utf8");
		expect(raw).toContain("REPLACE_ME");
	});

	test("the overlay documents imperative Secret creation", () => {
		const overlay = readFileSync(resolve(REPO_ROOT, KIND_OVERLAY), "utf8");
		expect(overlay).toContain("$patch: delete");
		expect(overlay).toMatch(/create secret|README\.md/);
	});
});
