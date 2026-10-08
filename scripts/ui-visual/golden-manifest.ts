/**
 * The golden generator manifest and its guard (warren-a132).
 *
 * `scripts/ui-visual/__golden__/manifest.json` sits beside the baselines.
 * The ui-visual workflow writes it right after it regenerates them in the
 * pinned Playwright container (`goldens.ts write`). It records the
 * Playwright version, the container image and digest, the commit the
 * pages rendered from, and the sha256 of every PNG. The guard
 * (`goldens.ts check`) holds the committed set to it, so a baseline made
 * on a laptop (any PNG whose hash the manifest does not list), a stale set
 * after a Playwright or image bump, a missing or orphaned case, and a set
 * over the 8 MB budget all fail before the comparison runs.
 *
 * Pure: the CLI does the file and YAML IO, and `bun test` covers the rest.
 */

import { GOLDEN_UPDATE_HINT } from "./golden-cases.ts";

export const GOLDEN_MANIFEST_SCHEMA = 1;
/** The only writer the guard accepts. */
export const GOLDEN_GENERATOR = ".github/workflows/ui-visual.yml";

export interface GoldenFileFact {
	readonly sha256: string;
	readonly bytes: number;
	readonly width: number;
	readonly height: number;
}

export interface GoldenManifest {
	readonly schema: typeof GOLDEN_MANIFEST_SCHEMA;
	readonly generator: typeof GOLDEN_GENERATOR;
	/** `@playwright/test` version that rendered the set. */
	readonly playwright: string;
	/** Container image without the digest, e.g. `mcr.microsoft.com/playwright:v1.64.0-noble`. */
	readonly image: string;
	/** `sha256:<64 hex>` the image was pinned to. */
	readonly digest: string;
	/** Commit the baselines rendered from. */
	readonly sha: string;
	/** The workflow run that generated the set, when known. */
	readonly run: { readonly id: string; readonly url: string } | null;
	/** One entry per baseline PNG, keyed by file name, sorted. */
	readonly files: Readonly<Record<string, GoldenFileFact>>;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Split `name:tag@sha256:…` into the image and its digest; null if unpinned. */
export function parseImageRef(ref: string): { image: string; digest: string } | null {
	const at = ref.indexOf("@");
	if (at <= 0) return null;
	const image = ref.slice(0, at);
	const digest = ref.slice(at + 1);
	return DIGEST.test(digest) ? { image, digest } : null;
}

/** Width and height from a PNG's IHDR chunk; null when it is not a PNG. */
export function pngSize(buf: Uint8Array): { width: number; height: number } | null {
	const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (buf.length < 24 || SIGNATURE.some((b, i) => buf[i] !== b)) return null;
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	if (String.fromCharCode(...buf.subarray(12, 16)) !== "IHDR") return null;
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function buildGoldenManifest(input: {
	playwright: string;
	imageRef: string;
	sha: string;
	run: { id: string; url: string } | null;
	files: Readonly<Record<string, GoldenFileFact>>;
}): GoldenManifest {
	const pinned = parseImageRef(input.imageRef);
	if (pinned === null) throw new Error(`image '${input.imageRef}' is not pinned by sha256 digest`);
	if (!SHA.test(input.sha)) throw new Error(`sha '${input.sha}' is not a 40-hex commit sha`);
	const files = Object.fromEntries(
		Object.keys(input.files)
			.sort()
			.map((name) => [name, input.files[name] as GoldenFileFact]),
	);
	return {
		schema: GOLDEN_MANIFEST_SCHEMA,
		generator: GOLDEN_GENERATOR,
		playwright: input.playwright,
		image: pinned.image,
		digest: pinned.digest,
		sha: input.sha,
		run: input.run,
		files,
	};
}

/** Stable, tab-indented JSON with a trailing newline, so diffs stay line-wise. */
export function serializeGoldenManifest(manifest: GoldenManifest): string {
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}

const matches = (re: RegExp, v: unknown): boolean => typeof v === "string" && re.test(v);

function isFileFact(fact: unknown): boolean {
	if (typeof fact !== "object" || fact === null) return false;
	const f = fact as Partial<GoldenFileFact>;
	return (
		matches(HEX64, f.sha256) &&
		[f.bytes, f.width, f.height].every((n) => typeof n === "number" && n > 0)
	);
}

/** Field-level problems in a parsed manifest object. */
function manifestFieldErrors(m: Record<string, unknown>): string[] {
	const errors: string[] = [];
	if (m.schema !== GOLDEN_MANIFEST_SCHEMA) errors.push(`schema must be ${GOLDEN_MANIFEST_SCHEMA}`);
	if (m.generator !== GOLDEN_GENERATOR) errors.push(`generator must be "${GOLDEN_GENERATOR}"`);
	for (const key of ["playwright", "image"] as const) {
		if (!matches(/./, m[key])) errors.push(`${key} must be a string`);
	}
	if (!matches(DIGEST, m.digest)) errors.push("digest must be sha256:<64 hex>");
	if (!matches(SHA, m.sha)) errors.push("sha must be a 40-hex commit");
	const files = m.files;
	if (typeof files !== "object" || files === null || Array.isArray(files)) {
		return [...errors, "files must be an object keyed by file name"];
	}
	for (const [name, fact] of Object.entries(files as Record<string, unknown>)) {
		if (!isFileFact(fact)) errors.push(`files["${name}"] needs sha256, bytes, width, and height`);
	}
	return errors;
}

/** Shape-check a manifest; returns problems instead of throwing. */
export function parseGoldenManifest(
	raw: string,
): { manifest: GoldenManifest; errors: [] } | { manifest: null; errors: string[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { manifest: null, errors: [`manifest.json is not JSON: ${(err as Error).message}`] };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { manifest: null, errors: ["manifest.json must be a JSON object"] };
	}
	const errors = manifestFieldErrors(parsed as Record<string, unknown>);
	return errors.length > 0
		? { manifest: null, errors }
		: { manifest: parsed as GoldenManifest, errors: [] };
}

export interface GoldenCheckInput {
	/** `manifest.json` contents, or null when the file is absent. */
	readonly manifestRaw: string | null;
	/** Facts for every PNG in `__golden__/`, keyed by file name. */
	readonly onDisk: Readonly<Record<string, GoldenFileFact>>;
	/** Entries in `__golden__/` that are neither a PNG nor the manifest. */
	readonly strays: readonly string[];
	/** File names the page manifest implies (`expectedGoldenFiles`). */
	readonly expected: readonly string[];
	/** The `@playwright/test` devDependency. */
	readonly playwright: string;
	/** The ui-visual workflow's `container.image` (`name:tag@sha256:…`). */
	readonly workflowImage: string;
	readonly maxBytes: number;
}

/** The set was rendered by another Playwright or image than the workflow pins now. */
function toolchainErrors(m: GoldenManifest, input: GoldenCheckInput): string[] {
	const pinned = parseImageRef(input.workflowImage);
	if (pinned === null) return [`workflow image '${input.workflowImage}' is not pinned by digest`];
	const stale: string[] = [];
	if (m.playwright !== input.playwright) {
		stale.push(`playwright ${m.playwright} != devDependency ${input.playwright}`);
	}
	if (m.image !== pinned.image || m.digest !== pinned.digest) {
		stale.push(`image ${m.image}@${m.digest} != workflow ${input.workflowImage}`);
	}
	if (stale.length === 0) return [];
	const why = stale.join("; ");
	return [`baselines were rendered by another toolchain (${why}); ${GOLDEN_UPDATE_HINT}`];
}

/** Every PNG must be the exact bytes the manifest recorded, and vice versa. */
function provenanceErrors(m: GoldenManifest, input: GoldenCheckInput): string[] {
	const notCi = `so not CI-generated; ${GOLDEN_UPDATE_HINT}`;
	const errors = Object.entries(input.onDisk)
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([name, disk]) => {
			const listed = m.files[name];
			if (listed === undefined) return [`${name}: not in manifest.json, ${notCi}`];
			const same = listed.sha256 === disk.sha256 && listed.bytes === disk.bytes;
			return same ? [] : [`${name}: sha256 differs from manifest.json, ${notCi}`];
		});
	const gone = Object.keys(m.files).filter((name) => input.onDisk[name] === undefined);
	return [...errors, ...gone.sort().map((n) => `${n}: listed in manifest.json but missing`)];
}

/** The PNG set must equal the page manifest's golden cases and fit the budget. */
function coverageErrors(input: GoldenCheckInput): string[] {
	const pngs = Object.keys(input.onDisk).sort();
	const expected = new Set(input.expected);
	const errors: string[] = [];
	const missing = input.expected.filter((n) => input.onDisk[n] === undefined);
	if (missing.length > 0) {
		errors.push(`no baseline for ${missing.join(", ")}; ${GOLDEN_UPDATE_HINT}`);
	}
	for (const name of pngs.filter((n) => !expected.has(n))) {
		errors.push(`${name}: no page manifest case renders it; delete it or ${GOLDEN_UPDATE_HINT}`);
	}
	const total = pngs.reduce((sum, n) => sum + (input.onDisk[n]?.bytes ?? 0), 0);
	if (total > input.maxBytes) {
		const mb = (b: number): string => (b / 1024 / 1024).toFixed(2);
		errors.push(`baselines total ${mb(total)} MB, over the ${mb(input.maxBytes)} MB budget`);
	}
	return errors;
}

/** Every reason the committed baselines are not a CI-generated set; empty when sound. */
export function checkGoldens(input: GoldenCheckInput): string[] {
	if (input.manifestRaw === null && Object.keys(input.onDisk).length === 0) {
		return [`no golden baselines are committed; ${GOLDEN_UPDATE_HINT}`];
	}
	const strays = input.strays.map((s) => `${s}: unexpected file in __golden__/`);
	if (input.manifestRaw === null) {
		const why = `manifest.json is missing, so no PNG is CI-generated; ${GOLDEN_UPDATE_HINT}`;
		return [...strays, why];
	}
	const parsed = parseGoldenManifest(input.manifestRaw);
	if (parsed.manifest === null) return [...strays, ...parsed.errors];
	return [
		...strays,
		...toolchainErrors(parsed.manifest, input),
		...provenanceErrors(parsed.manifest, input),
		...coverageErrors(input),
	];
}
