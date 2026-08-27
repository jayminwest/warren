#!/usr/bin/env bun
/**
 * Package-UI smoke gate (warren-402e, plan pl-26f3 step 1).
 *
 * Packs the npm tarball in dry-run mode and asserts the built UI rides
 * inside it: `src/ui/dist/index.html` plus at least one hashed asset
 * under `src/ui/dist/assets/`, and NO UI sources leaking in. This is the
 * release-time guarantee that `npm publish` can never ship a UI-less
 * package: the release workflow runs `build:ui` first and this check
 * second, so a publish that skipped the build fails loudly here.
 *
 * Usage:
 *   bun run check:package-ui
 *
 * The manifest assertion logic is exported (assertUiInPackManifest) so
 * scripts/check-package-ui.test.ts pins it against fixture listings
 * without invoking npm.
 */

import { spawnSync } from "node:child_process";

interface PackFile {
	readonly path: string;
}

interface PackManifest {
	readonly files: readonly PackFile[];
}

export interface PackAssertionFailure {
	readonly problems: readonly string[];
}

const INDEX_ENTRY = "src/ui/dist/index.html";
const ASSETS_PREFIX = "src/ui/dist/assets/";
const UI_SOURCES_PATTERN = /^src\/ui\/(?!dist\/)/;

/**
 * Assert the built UI is present in an npm pack manifest and no UI
 * sources leak into the tarball. Returns the failure list — empty means
 * the manifest is good.
 */
export function assertUiInPackManifest(manifest: PackManifest): PackAssertionFailure {
	const problems: string[] = [];
	const paths = manifest.files.map((file) => file.path);

	if (!paths.includes(INDEX_ENTRY)) {
		problems.push(
			`pack listing has no ${INDEX_ENTRY} — run \`bun run build:ui\` before publishing (warren-402e)`,
		);
	}
	if (!paths.some((path) => path.startsWith(ASSETS_PREFIX))) {
		problems.push(
			`pack listing has no entries under ${ASSETS_PREFIX} — the built UI output is missing`,
		);
	}
	for (const path of paths) {
		if (UI_SOURCES_PATTERN.test(path)) {
			problems.push(
				`pack listing includes UI source ${path} — only src/ui/dist should ship (warren-402e)`,
			);
		}
	}
	return { problems };
}

function run(): number {
	// `npm pack --dry-run --json` prints a JSON array of manifests; take
	// the first (single-package invocation).
	const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
		encoding: "utf8",
	});
	if (result.error !== undefined) {
		console.error(`::error::failed to run npm pack: ${result.error.message}`);
		return 1;
	}
	if (result.status !== 0) {
		console.error(`::error::npm pack exited ${result.status}`);
		return 1;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		console.error("::error::npm pack --json emitted unparseable output");
		return 1;
	}
	const manifests = Array.isArray(parsed) ? parsed : [];
	const manifest = manifests[0] as PackManifest | undefined;
	if (manifest === undefined || !Array.isArray(manifest.files)) {
		console.error("::error::npm pack --json returned no manifest with files");
		return 1;
	}
	const { problems } = assertUiInPackManifest(manifest);
	if (problems.length > 0) {
		for (const problem of problems) {
			console.error(`::error::${problem}`);
		}
		console.error(
			"::error::the npm tarball is missing the built UI; a publish now would ship a dead web surface",
		);
		return 1;
	}
	console.log(
		`check-package-ui: ${INDEX_ENTRY} + ${manifest.files.filter((file) => file.path.startsWith(ASSETS_PREFIX)).length} asset(s) present in the pack listing`,
	);
	return 0;
}

if (import.meta.main) {
	process.exit(run());
}
