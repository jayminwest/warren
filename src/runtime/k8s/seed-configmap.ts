/**
 * Seed-file delivery via ConfigMap (pl-829f step 15 / warren-2181, design
 * k8s-migration.md §4.2). A `RunSpec` carries `seedFiles` — the
 * `.canopy/.mulch/.seeds/.pi` context drops the domain writes into the
 * workspace. LocalProvider hands them to burrow's `seed.files`; the K8s backend
 * has no such channel, so it ships them as a ConfigMap the init container reads.
 *
 * A ConfigMap volume flattens keys to files in one directory and cannot
 * reproduce an arbitrary tree (`.canopy/agent.json`, `.mulch/…`). So rather than
 * one key per file, the whole set travels as a single JSON manifest under one
 * key (`seeds.json`); the init entrypoint (`./workspace-init.ts`) parses it and
 * writes each entry at its real path inside `/workspace` after checkout. This
 * preserves the tree, carries `encoding`/`mode`, and keeps binary drops (base64)
 * as plain strings the init decodes — no ConfigMap `binaryData` needed.
 *
 * ConfigMaps are capped at ~1 MiB by etcd; `buildSeedConfigMap` refuses an
 * oversize manifest with a structured `RuntimeProviderError` rather than letting
 * the API reject it opaquely at create time. The ConfigMap is labelled
 * `warren.io/run-id` so the pod-GC loop (plan step 19) reclaims it with the pod.
 */

import type { V1ConfigMap } from "@kubernetes/client-node";
import type { RunSpec } from "../contract.ts";
import { RuntimeProviderError } from "../errors.ts";
import {
	type K8sPodConfig,
	LABEL_MANAGED_BY,
	LABEL_RUN_ID,
	MANAGED_BY_VALUE,
	SEED_MANIFEST_KEY,
} from "./pod-spec.ts";

/**
 * ConfigMap total-data ceiling. etcd caps a ConfigMap at 1 MiB across all keys;
 * we guard the serialized manifest against the same limit so oversize seed sets
 * fail fast in the provider with a clear message instead of a raw 4xx.
 */
export const CONFIGMAP_MAX_BYTES = 1024 * 1024;

/** One seed file as it travels in the manifest. Mirrors `RunSpec.seedFiles[number]`. */
export interface SeedManifestEntry {
	path: string;
	contents: string;
	encoding?: string;
	mode?: number;
}

/** Deterministic ConfigMap name for a run — the pod name plus a `-seeds` suffix. */
export function seedConfigMapName(podName: string): string {
	return `${podName}-seeds`;
}

/** Serialize the RunSpec seed files into the manifest JSON stored under `seeds.json`. */
export function serializeSeedManifest(files: ReadonlyArray<RunSpec["seedFiles"][number]>): string {
	const entries: SeedManifestEntry[] = files.map((f) => ({
		path: f.path,
		contents: f.contents,
		...(f.encoding !== undefined ? { encoding: f.encoding } : {}),
		...(f.mode !== undefined ? { mode: f.mode } : {}),
	}));
	return JSON.stringify(entries);
}

/**
 * Parse + validate the manifest the init container reads back. Rejects a
 * non-array or an entry missing `path`/`contents` so a corrupt ConfigMap surfaces
 * as a workspace-init failure rather than silently writing garbage.
 */
export function parseSeedManifest(raw: string): SeedManifestEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new RuntimeProviderError("seed manifest is not valid JSON", { cause: err });
	}
	if (!Array.isArray(parsed)) {
		throw new RuntimeProviderError("seed manifest must be a JSON array");
	}
	return parsed.map((entry, i) => {
		if (typeof entry !== "object" || entry === null) {
			throw new RuntimeProviderError(`seed manifest entry ${i} is not an object`);
		}
		const rec = entry as Record<string, unknown>;
		if (typeof rec.path !== "string" || typeof rec.contents !== "string") {
			throw new RuntimeProviderError(`seed manifest entry ${i} needs string path + contents`);
		}
		return {
			path: rec.path,
			contents: rec.contents,
			...(typeof rec.encoding === "string" ? { encoding: rec.encoding } : {}),
			...(typeof rec.mode === "number" ? { mode: rec.mode } : {}),
		};
	});
}

/**
 * Build the ConfigMap that carries a run's seed files. Throws
 * `RuntimeProviderError` when the serialized manifest exceeds the 1 MiB ConfigMap
 * limit. Caller (`K8sProvider.create`) creates it before the pod and points the
 * init container at `SEED_MANIFEST_KEY` via the seed volume mount.
 */
export function buildSeedConfigMap(
	spec: RunSpec,
	config: K8sPodConfig,
	podName: string,
): V1ConfigMap {
	const manifest = serializeSeedManifest(spec.seedFiles);
	const bytes = Buffer.byteLength(manifest, "utf8");
	if (bytes > CONFIGMAP_MAX_BYTES) {
		throw new RuntimeProviderError(
			`seed files exceed the ConfigMap 1 MiB limit (${bytes} bytes across ${spec.seedFiles.length} file(s))`,
			{
				recoveryHint:
					"trim the .canopy/.mulch/.seeds drops for this run, or split the large context out of seedFiles.",
			},
		);
	}
	return {
		apiVersion: "v1",
		kind: "ConfigMap",
		metadata: {
			name: seedConfigMapName(podName),
			namespace: config.namespace,
			labels: {
				[LABEL_RUN_ID]: spec.runId,
				[LABEL_MANAGED_BY]: MANAGED_BY_VALUE,
			},
		},
		data: { [SEED_MANIFEST_KEY]: manifest },
	};
}
