/**
 * Golden baseline bookkeeping for the ui-visual harness (warren-a132).
 *
 *   bun run scripts/ui-visual/goldens.ts check   # the guard; `bun run check:ui-goldens`
 *   bun run scripts/ui-visual/goldens.ts write   # CI only: write __golden__/manifest.json
 *
 * `write` runs in the ui-visual workflow right after
 * `check:ui-visual --update-snapshots=all`. It refuses to run outside the
 * pinned container (`goldenGate`), records the generator facts and every
 * PNG's sha256, then runs the guard over the result. `check` runs before
 * every comparison in the same workflow. The rules live in
 * `golden-manifest.ts`.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

import {
	expectedGoldenFiles,
	GOLDEN_DIR_NAME,
	GOLDEN_MANIFEST_FILE,
	GOLDEN_UPDATE_HINT,
	goldenGate,
	MAX_GOLDEN_BYTES,
} from "./golden-cases.ts";
import {
	buildGoldenManifest,
	checkGoldens,
	type GoldenFileFact,
	pngSize,
	serializeGoldenManifest,
} from "./golden-manifest.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const GOLDEN_DIR = join(import.meta.dir, GOLDEN_DIR_NAME);
const MANIFEST_PATH = join(GOLDEN_DIR, GOLDEN_MANIFEST_FILE);
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "ui-visual.yml");

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function devDependencyVersion(): string {
	const pkg = readJson(join(REPO_ROOT, "package.json")) as {
		devDependencies?: Record<string, string>;
	};
	return pkg.devDependencies?.["@playwright/test"] ?? "";
}

function workflowImage(): string {
	const wf = load(readFileSync(WORKFLOW, "utf8")) as {
		jobs?: Record<string, { container?: { image?: string } }>;
	};
	return wf.jobs?.["ui-visual"]?.container?.image ?? "";
}

/** Facts for each PNG in `__golden__/`, plus anything else that sits there. */
function scanGoldenDir(): { onDisk: Record<string, GoldenFileFact>; strays: string[] } {
	const onDisk: Record<string, GoldenFileFact> = {};
	const strays: string[] = [];
	if (!existsSync(GOLDEN_DIR)) return { onDisk, strays };
	for (const name of readdirSync(GOLDEN_DIR).sort()) {
		if (name === GOLDEN_MANIFEST_FILE) continue;
		const buf = readFileSync(join(GOLDEN_DIR, name));
		const size = name.endsWith(".png") ? pngSize(buf) : null;
		if (size === null) {
			strays.push(name);
			continue;
		}
		const sha256 = createHash("sha256").update(buf).digest("hex");
		onDisk[name] = { sha256, bytes: buf.byteLength, ...size };
	}
	return { onDisk, strays };
}

function check(): number {
	const { onDisk, strays } = scanGoldenDir();
	const errors = checkGoldens({
		manifestRaw: existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, "utf8") : null,
		onDisk,
		strays,
		expected: expectedGoldenFiles(),
		playwright: devDependencyVersion(),
		workflowImage: workflowImage(),
		maxBytes: MAX_GOLDEN_BYTES,
	});
	if (errors.length > 0) {
		console.error(`ui-goldens: ${errors.length} problem(s) in scripts/ui-visual/__golden__/`);
		for (const e of errors) console.error(`  - ${e}`);
		console.error(`ui-goldens: to fix, ${GOLDEN_UPDATE_HINT}`);
		return 1;
	}
	const total = Object.values(onDisk).reduce((sum, f) => sum + f.bytes, 0);
	const mb = (total / 1024 / 1024).toFixed(2);
	console.log(`ui-goldens: ${Object.keys(onDisk).length} baselines, ${mb} MB, CI-generated`);
	return 0;
}

function write(): number {
	const gate = goldenGate(process.env, process.platform, process.arch);
	if (!gate.enabled) {
		console.error(`ui-goldens: refusing to write the manifest: ${gate.reason}`);
		return 1;
	}
	const sha = process.env.HEAD_SHA ?? process.env.GITHUB_SHA ?? "";
	const installed = readJson(join(REPO_ROOT, "node_modules", "@playwright", "test", "package.json"))
		.version as string;
	if (installed !== devDependencyVersion()) {
		console.error(`ui-goldens: installed playwright ${installed} != devDependency`);
		return 1;
	}
	const runId = process.env.GITHUB_RUN_ID;
	const server = process.env.GITHUB_SERVER_URL;
	const repo = process.env.GITHUB_REPOSITORY;
	const run =
		runId && server && repo ? { id: runId, url: `${server}/${repo}/actions/runs/${runId}` } : null;
	const manifest = buildGoldenManifest({
		playwright: installed,
		imageRef: workflowImage(),
		sha,
		run,
		files: scanGoldenDir().onDisk,
	});
	writeFileSync(MANIFEST_PATH, serializeGoldenManifest(manifest));
	console.log(`ui-goldens: wrote ${MANIFEST_PATH}`);
	return check();
}

if (import.meta.main) {
	const command = process.argv[2];
	if (command === "check") process.exit(check());
	if (command === "write") process.exit(write());
	console.error("usage: bun run scripts/ui-visual/goldens.ts <check|write>");
	process.exit(2);
}
