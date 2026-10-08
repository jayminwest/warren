import { describe, expect, test } from "bun:test";

import {
	buildGoldenManifest,
	checkGoldens,
	type GoldenCheckInput,
	type GoldenFileFact,
	parseGoldenManifest,
	parseImageRef,
	pngSize,
	serializeGoldenManifest,
} from "./golden-manifest.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = "mcr.microsoft.com/playwright:v1.64.0-noble";
const IMAGE_REF = `${IMAGE}@${DIGEST}`;
const SHA = "b".repeat(40);

const fact = (seed: string, bytes = 100): GoldenFileFact => ({
	sha256: seed.repeat(64).slice(0, 64),
	bytes,
	width: 1440,
	height: 900,
});

const FILES: Record<string, GoldenFileFact> = {
	"runs-desktop-light.png": fact("1"),
	"runs-desktop-dark.png": fact("2"),
	"runs-phone-light.png": fact("3"),
};
const EXPECTED = Object.keys(FILES).sort();

function manifestRaw(overrides: Partial<Parameters<typeof buildGoldenManifest>[0]> = {}): string {
	return serializeGoldenManifest(
		buildGoldenManifest({
			playwright: "1.64.0",
			imageRef: IMAGE_REF,
			sha: SHA,
			run: { id: "1", url: "https://github.com/o/r/actions/runs/1" },
			files: FILES,
			...overrides,
		}),
	);
}

function input(overrides: Partial<GoldenCheckInput> = {}): GoldenCheckInput {
	return {
		manifestRaw: manifestRaw(),
		onDisk: FILES,
		strays: [],
		expected: EXPECTED,
		playwright: "1.64.0",
		workflowImage: IMAGE_REF,
		maxBytes: 8 * 1024 * 1024,
		...overrides,
	};
}

describe("parseImageRef", () => {
	test("splits a digest-pinned ref", () => {
		expect(parseImageRef(IMAGE_REF)).toEqual({ image: IMAGE, digest: DIGEST });
	});

	test("rejects a tag-only or malformed ref", () => {
		expect(parseImageRef(IMAGE)).toBeNull();
		expect(parseImageRef(`${IMAGE}@sha256:short`)).toBeNull();
	});
});

describe("pngSize", () => {
	test("reads width and height from IHDR", () => {
		const buf = new Uint8Array(24);
		buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
		const view = new DataView(buf.buffer);
		view.setUint32(16, 393);
		view.setUint32(20, 3852);
		expect(pngSize(buf)).toEqual({ width: 393, height: 3852 });
	});

	test("returns null for anything that is not a PNG", () => {
		expect(pngSize(new TextEncoder().encode("not a png, just some text"))).toBeNull();
		expect(pngSize(new Uint8Array(4))).toBeNull();
	});
});

describe("buildGoldenManifest", () => {
	test("sorts files and serializes with a trailing newline", () => {
		const raw = manifestRaw();
		expect(raw.endsWith("}\n")).toBe(true);
		const parsed = parseGoldenManifest(raw);
		expect(parsed.errors).toEqual([]);
		expect(Object.keys(parsed.manifest?.files ?? {})).toEqual(EXPECTED);
		expect(parsed.manifest?.image).toBe(IMAGE);
		expect(parsed.manifest?.digest).toBe(DIGEST);
	});

	test("refuses an unpinned image or a short sha", () => {
		expect(() => manifestRaw({ imageRef: IMAGE })).toThrow("not pinned");
		expect(() => manifestRaw({ sha: "abc" })).toThrow("40-hex");
	});
});

describe("parseGoldenManifest", () => {
	test("reports every malformed field", () => {
		const raw = JSON.stringify({ schema: 2, files: { "x.png": { sha256: "no" } } });
		const parsed = parseGoldenManifest(raw);
		expect(parsed.manifest).toBeNull();
		expect(parsed.errors.join("\n")).toContain("schema must be 1");
		expect(parsed.errors.join("\n")).toContain("generator must be");
		expect(parsed.errors.join("\n")).toContain("digest must be");
		expect(parsed.errors.join("\n")).toContain('files["x.png"]');
	});

	test("reports invalid JSON", () => {
		expect(parseGoldenManifest("{").errors[0]).toContain("not JSON");
	});
});

describe("checkGoldens", () => {
	test("accepts a CI-generated set", () => {
		expect(checkGoldens(input())).toEqual([]);
	});

	test("reports an empty directory once", () => {
		expect(checkGoldens(input({ manifestRaw: null, onDisk: {} }))).toEqual([
			"no golden baselines are committed",
		]);
	});

	test("rejects PNGs without a manifest", () => {
		expect(checkGoldens(input({ manifestRaw: null })).join("\n")).toContain(
			"manifest.json is missing",
		);
	});

	test("rejects a laptop-rendered PNG whose hash the manifest does not list", () => {
		const onDisk = { ...FILES, "runs-desktop-light.png": fact("f") };
		expect(checkGoldens(input({ onDisk }))).toEqual([
			expect.stringContaining("runs-desktop-light.png: sha256 differs"),
		]);
	});

	test("rejects a PNG the manifest never listed", () => {
		const onDisk = { ...FILES, "agents-desktop-light.png": fact("4") };
		const errors = checkGoldens(input({ onDisk })).join("\n");
		expect(errors).toContain("agents-desktop-light.png: not in manifest.json");
		expect(errors).toContain("agents-desktop-light.png: no page manifest case renders it");
	});

	test("rejects a set rendered by another Playwright or image", () => {
		const errors = checkGoldens(
			input({ playwright: "1.65.0", workflowImage: `${IMAGE}@sha256:${"c".repeat(64)}` }),
		).join("\n");
		expect(errors).toContain("playwright 1.64.0 != devDependency 1.65.0");
		expect(errors).toContain("!= workflow");
	});

	test("reports cases with no baseline and manifest entries with no file", () => {
		const { "runs-phone-light.png": _gone, ...rest } = FILES;
		const errors = checkGoldens(input({ onDisk: rest })).join("\n");
		expect(errors).toContain("runs-phone-light.png: listed in manifest.json but missing");
		expect(errors).toContain("no baseline for runs-phone-light.png");
	});

	test("rejects stray files and a set over budget", () => {
		const errors = checkGoldens(input({ strays: ["notes.txt"], maxBytes: 200 })).join("\n");
		expect(errors).toContain("notes.txt: unexpected file");
		expect(errors).toContain("over the 0.00 MB budget");
	});
});
