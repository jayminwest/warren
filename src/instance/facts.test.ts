/**
 * Domain tests for instance facts (warren-2eec / pl-7e38 step 17).
 *
 * The safety contract is structural: buildInstanceFacts only ever emits the
 * fields named in InstanceFacts, so the no-secrets assertion here proves the
 * allowlist holds even when the input env carries credential-shaped values.
 */

import { describe, expect, test } from "bun:test";
import { VERSION } from "../index.ts";
import { buildInstanceFacts, type InstanceFacts, publicInstanceFacts } from "./facts.ts";

const SECRET_ENV = {
	WARREN_API_TOKEN: "super-secret-token-abcdef",
	WARREN_DB_URL: "postgres://user:password@db.internal.example.com:5432/warren",
	WARREN_K8S_MAX_QUEUE_DEPTH: "7",
	WARREN_K8S_MAX_PENDING_PODS: "3",
	WARREN_K8S_MAX_PROJECT_CONCURRENCY: "2",
} as const;

function baseInput(overrides: Record<string, string | undefined> = {}) {
	return {
		env: { ...SECRET_ENV, ...overrides },
		authMode: "token" as const,
		dbBackend: "sqlite" as const,
		uptimeSeconds: 12.9,
	};
}

describe("buildInstanceFacts", () => {
	test("resolves local runtime facts from env", () => {
		const facts = buildInstanceFacts(baseInput({ WARREN_RUNTIME: undefined }));
		expect(facts).toEqual({
			version: VERSION,
			runtime: "local",
			authMode: "token",
			dbBackend: "sqlite",
			uptimeSeconds: 12,
			admission: null,
		});
	});

	test("surfaces K8s admission caps only under WARREN_RUNTIME=k8s", () => {
		const facts = buildInstanceFacts(baseInput({ WARREN_RUNTIME: "k8s" }));
		expect(facts.runtime).toBe("k8s");
		expect(facts.admission).toEqual({
			maxQueueDepth: 7,
			maxPendingPods: 3,
			maxProjectConcurrency: 2,
		});
	});

	test("k8s admission caps fall back to the documented defaults", () => {
		const facts = buildInstanceFacts(
			baseInput({
				WARREN_RUNTIME: "k8s",
				WARREN_K8S_MAX_QUEUE_DEPTH: undefined,
				WARREN_K8S_MAX_PENDING_PODS: undefined,
				WARREN_K8S_MAX_PROJECT_CONCURRENCY: undefined,
			}),
		);
		expect(facts.admission).toEqual({
			maxQueueDepth: 50,
			maxPendingPods: 20,
			maxProjectConcurrency: null,
		});
	});

	test("never emits secrets from the input env", () => {
		const facts: unknown = buildInstanceFacts(baseInput({ WARREN_RUNTIME: "k8s" }));
		const text = JSON.stringify(facts);
		for (const marker of [
			"super-secret-token",
			"postgres://",
			"password",
			"db.internal.example.com",
		]) {
			expect(text.includes(marker)).toBe(false);
		}
	});

	test("floors negative uptime at zero and truncates fractions", () => {
		expect(buildInstanceFacts({ ...baseInput(), uptimeSeconds: -5 }).uptimeSeconds).toBe(0);
		expect(
			buildInstanceFacts({ ...baseInput({ WARREN_RUNTIME: "docker" }), uptimeSeconds: 3.7 })
				.uptimeSeconds,
		).toBe(3);
	});

	test("reports a null dbBackend when no db is wired", () => {
		const facts = buildInstanceFacts({ ...baseInput(), dbBackend: null });
		expect(facts.dbBackend).toBeNull();
	});
});

describe("publicInstanceFacts", () => {
	test("keeps only the three static facts", () => {
		const facts: InstanceFacts = buildInstanceFacts(baseInput({ WARREN_RUNTIME: "k8s" }));
		const pub = publicInstanceFacts(facts);
		expect(Object.keys(pub).sort()).toEqual(["authMode", "runtime", "version"]);
		expect(pub.version).toBe(VERSION);
	});
});
