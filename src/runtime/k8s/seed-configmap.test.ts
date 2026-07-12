import { describe, expect, test } from "bun:test";
import type { RunSpec } from "../contract.ts";
import { RuntimeProviderError } from "../errors.ts";
import {
	LABEL_MANAGED_BY,
	LABEL_RUN_ID,
	MANAGED_BY_VALUE,
	resolveK8sPodConfig,
	SEED_MANIFEST_KEY,
} from "./pod-spec.ts";
import {
	buildSeedConfigMap,
	CONFIGMAP_MAX_BYTES,
	parseSeedManifest,
	seedConfigMapName,
	serializeSeedManifest,
} from "./seed-configmap.ts";

const config = resolveK8sPodConfig({});

function baseSpec(overrides: Partial<RunSpec> = {}): RunSpec {
	return {
		runId: "run_abc",
		originUrl: "https://github.com/acme/widgets.git",
		branch: "warren/run_abc",
		baseBranch: "main",
		runtimeId: "claude-code",
		prompt: "do the thing",
		mode: "batch",
		network: "restricted",
		seedFiles: [],
		env: {},
		...overrides,
	};
}

describe("seedConfigMapName", () => {
	test("suffixes the pod name with -seeds", () => {
		expect(seedConfigMapName("run-run-abc")).toBe("run-run-abc-seeds");
	});
});

describe("serializeSeedManifest / parseSeedManifest", () => {
	test("round-trips path/contents/encoding/mode", () => {
		const files = [
			{ path: ".canopy/agent.json", contents: "{}" },
			{ path: ".mulch/x.jsonl", contents: "Zm9v", encoding: "base64", mode: 0o644 },
		];
		const parsed = parseSeedManifest(serializeSeedManifest(files));
		expect(parsed).toEqual([
			{ path: ".canopy/agent.json", contents: "{}" },
			{ path: ".mulch/x.jsonl", contents: "Zm9v", encoding: "base64", mode: 0o644 },
		]);
	});

	test("omits absent optional fields", () => {
		const parsed = JSON.parse(serializeSeedManifest([{ path: "a", contents: "b" }]));
		expect(parsed[0]).toEqual({ path: "a", contents: "b" });
		expect("encoding" in parsed[0]).toBe(false);
		expect("mode" in parsed[0]).toBe(false);
	});

	test("rejects non-JSON", () => {
		expect(() => parseSeedManifest("not json")).toThrow(RuntimeProviderError);
	});

	test("rejects a non-array top level", () => {
		expect(() => parseSeedManifest('{"path":"a"}')).toThrow(/must be a JSON array/);
	});

	test("rejects an entry missing path/contents", () => {
		expect(() => parseSeedManifest('[{"path":"a"}]')).toThrow(/string path \+ contents/);
		expect(() => parseSeedManifest("[42]")).toThrow(/not an object/);
	});
});

describe("buildSeedConfigMap", () => {
	test("builds a ConfigMap labelled with the run id and carrying the manifest", () => {
		const cm = buildSeedConfigMap(
			baseSpec({ seedFiles: [{ path: ".seeds/issues.jsonl", contents: "line" }] }),
			config,
			"run-run-abc",
		);
		expect(cm.kind).toBe("ConfigMap");
		expect(cm.metadata?.name).toBe("run-run-abc-seeds");
		expect(cm.metadata?.namespace).toBe(config.namespace);
		expect(cm.metadata?.labels?.[LABEL_RUN_ID]).toBe("run_abc");
		expect(cm.metadata?.labels?.[LABEL_MANAGED_BY]).toBe(MANAGED_BY_VALUE);
		const manifest = cm.data?.[SEED_MANIFEST_KEY];
		expect(JSON.parse(manifest ?? "[]")).toEqual([
			{ path: ".seeds/issues.jsonl", contents: "line" },
		]);
	});

	test("throws a structured error when the manifest exceeds the 1 MiB ConfigMap limit", () => {
		const huge = "x".repeat(CONFIGMAP_MAX_BYTES + 1);
		expect(() =>
			buildSeedConfigMap(
				baseSpec({ seedFiles: [{ path: "big", contents: huge }] }),
				config,
				"run-run-abc",
			),
		).toThrow(RuntimeProviderError);
	});

	test("allows a manifest right under the limit", () => {
		const almost = "x".repeat(CONFIGMAP_MAX_BYTES - 100);
		expect(() =>
			buildSeedConfigMap(
				baseSpec({ seedFiles: [{ path: "b", contents: almost }] }),
				config,
				"run-run-abc",
			),
		).not.toThrow();
	});
});
