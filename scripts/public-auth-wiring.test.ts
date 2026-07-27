import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load, loadAll } from "js-yaml";

import { AUTH_KINDS, DEFAULT_AUTH_KIND } from "../src/server/auth.ts";
import { WARREN_PUBLIC_ALLOWLIST_ENV } from "../src/server/public-allowlist.ts";

// Guards the public-instance auth wiring (warren-851b / warren-ce9b / warren-1841).
//
// The auth posture has two halves that nothing else can check. The SOURCE
// half reads `WARREN_AUTH` and `WARREN_PUBLIC_ALLOWLIST` from the process
// env; the MANIFEST half is the only thing that ever puts them there. Neither
// the compiler nor kustomize relates the two, and the failure is silent in the
// worst direction: `kubectl apply` succeeds, the operator sets the Secret key,
// the pod restarts — and the instance quietly stays in whatever mode it was
// already in, because no env var was ever plumbed to the container.
//
// That is not hypothetical. Both env vars shipped fully implemented and
// tested in src/, and the Deployment never carried either one; the gap was
// found while planning the cutover that depended on it.
//
// The other property under test is ROLLBACK SHAPE. Sourcing the posture from
// a Secret (rather than a literal `value:` in the overlay) is what makes
// "flip it back" a Secret edit plus a rollout restart instead of a commit →
// release → deploy cycle. A well-meaning future change to a plain `value:`
// would look tidier and would quietly cost the revert path.

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEPLOYMENT = "deploy/k8s/base/deployment.yaml";
const SECRETS = "deploy/k8s/base/secrets.yaml";
const K8S_README = "deploy/k8s/README.md";
const AUTH_SOURCE = "src/server/auth.ts";

/** The env var name `resolveAuthKind` reads. No constant exists in source for
 *  it (it is read inline off `env`), so the literal is pinned here AND the
 *  source is asserted to still reference it — a rename must break this test
 *  rather than silently orphan the manifest. */
const WARREN_AUTH_ENV = "WARREN_AUTH";

const SECRET_NAME = "warren-secrets";
const AUTH_KEY = "warren-auth";
const ALLOWLIST_KEY = "warren-public-allowlist";

function readRepoFile(path: string): string {
	return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

interface EnvEntry {
	name?: string;
	value?: string;
	valueFrom?: {
		secretKeyRef?: { name?: string; key?: string; optional?: boolean };
	};
}

interface SecretDoc {
	metadata?: { name?: string };
	stringData?: Record<string, string>;
}

interface DeploymentDoc {
	spec?: {
		template?: {
			spec?: { containers?: { name?: string; env?: EnvEntry[] }[] };
		};
	};
}

function controlPlaneEnv(): EnvEntry[] {
	const doc = load(readRepoFile(DEPLOYMENT)) as DeploymentDoc;
	const containers = doc.spec?.template?.spec?.containers ?? [];
	const warren = containers.find((c) => c.name === "warren");
	if (!warren) throw new Error(`no container named "warren" in ${DEPLOYMENT}`);
	return warren.env ?? [];
}

function envEntry(name: string): EnvEntry {
	const entry = controlPlaneEnv().find((e) => e.name === name);
	if (!entry) throw new Error(`${DEPLOYMENT} does not supply env ${name}`);
	return entry;
}

describe("the Deployment supplies the auth-posture env vars", () => {
	for (const name of [WARREN_AUTH_ENV, WARREN_PUBLIC_ALLOWLIST_ENV]) {
		test(`${name} reaches the container`, () => {
			expect(controlPlaneEnv().map((e) => e.name)).toContain(name);
		});

		test(`${name} is sourced from the ${SECRET_NAME} Secret, not a literal`, () => {
			const entry = envEntry(name);
			// A literal `value:` would work, but it moves the revert off the
			// Secret-edit path and into a redeploy. See the header note.
			expect(entry.value).toBeUndefined();
			expect(entry.valueFrom?.secretKeyRef?.name).toBe(SECRET_NAME);
		});

		test(`${name} is optional so a fresh install boots without the key`, () => {
			expect(envEntry(name).valueFrom?.secretKeyRef?.optional).toBe(true);
		});
	}

	test("the Secret keys are the ones the README tells operators to set", () => {
		expect(envEntry(WARREN_AUTH_ENV).valueFrom?.secretKeyRef?.key).toBe(AUTH_KEY);
		expect(envEntry(WARREN_PUBLIC_ALLOWLIST_ENV).valueFrom?.secretKeyRef?.key).toBe(ALLOWLIST_KEY);
	});
});

describe("source and manifest still agree on the env var names", () => {
	test(`${AUTH_SOURCE} still reads ${WARREN_AUTH_ENV}`, () => {
		// The manifest half is pinned to a literal; this is the other end of
		// that pin. Renaming the env var in source without touching the
		// Deployment must fail here.
		expect(readRepoFile(AUTH_SOURCE)).toContain(`env.${WARREN_AUTH_ENV}`);
	});

	test("the allowlist env name is imported, not retyped", () => {
		// Sanity: the constant this file imports is the real one, so the
		// Deployment assertions above are anchored to source.
		expect(WARREN_PUBLIC_ALLOWLIST_ENV).toBe("WARREN_PUBLIC_ALLOWLIST");
	});
});

describe("the Secret template documents both keys", () => {
	test("secrets.yaml carries them so the key layout stays in one place", () => {
		const secrets = readRepoFile(SECRETS);
		expect(secrets).toContain(`${AUTH_KEY}:`);
		expect(secrets).toContain(`${ALLOWLIST_KEY}:`);
	});

	test("the template defaults to the private posture", () => {
		// A template that shipped `warren-auth: "public"` would be a footgun
		// for anyone who applies it before reading the warning at the top.
		// secrets.yaml holds two docs (warren-secrets + warren-git-token).
		const docs = loadAll(readRepoFile(SECRETS)) as SecretDoc[];
		const control = docs.find((d) => d?.metadata?.name === SECRET_NAME);
		expect(control).toBeDefined();
		expect(control?.stringData?.[AUTH_KEY] ?? "").not.toBe("public");
	});
});

describe("the operator docs describe the flip and the revert", () => {
	const readme = () => readRepoFile(K8S_README);

	test("both recognized auth values are named", () => {
		for (const kind of AUTH_KINDS) expect(readme()).toContain(kind);
	});

	test("the default posture is stated", () => {
		expect(readme()).toContain(DEFAULT_AUTH_KIND);
	});

	test("a rollout restart is spelled out — a Secret edit alone changes nothing", () => {
		// Env from a secretKeyRef is resolved at pod start. Editing the Secret
		// without restarting leaves the running pod on the old posture, which
		// reads as "the flip did not work".
		expect(readme()).toContain("rollout restart deploy/warren");
	});
});
