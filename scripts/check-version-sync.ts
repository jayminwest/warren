#!/usr/bin/env bun
/**
 * Version-sync guard (warren-0210, plan pl-b82d step 6).
 *
 * Warren's version is written down in four places. Before this guard, the
 * only mechanical check was `release.yml`'s `package.json` vs
 * `src/index.ts` comparison — which runs at release time, on the release
 * branch, and via GNU-only `grep -oP`. Everything else drifted silently:
 * the README `## Status` line sat two releases behind.
 *
 * One consistency group: **warren release version** — `package.json`
 * `version` (canonical), `src/index.ts` `VERSION`, `docs/openapi.yaml`
 * `info.version`, and the semver in README's `## Status` paragraph.
 * `scripts/version-bump.ts` writes all four; this gate asserts nobody
 * hand-edited one of them. The README locator is IMPORTED from
 * version-bump.ts so the bumper and the gate can never disagree about
 * where the version lives. (The burrow-cli pin group left with the
 * dependency in warren-ea0a.)
 *
 * Chained into `bun run lint` (alongside check-layers.ts)
 * rather than registered as its own gate: `scripts/check-all.ts` is
 * byte-identical to the l5-toolkit template and its canonical gate
 * vocabulary is frozen, so a repo-specific assertion folds into an
 * existing gate instead. Also runnable directly:
 * `bun run check:version-sync`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { locateReadmeStatusVersion } from "./version-bump.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

export interface VersionSite {
	/** Repo-relative path, e.g. `package.json`. */
	readonly file: string;
	/** Where inside that file the version lives, e.g. `"version" field`. */
	readonly where: string;
	readonly version: string;
}

export interface SiteGroup {
	/** Human name for the thing being versioned, used in the failure message. */
	readonly name: string;
	/** Sites that must all agree; the FIRST one is canonical. */
	readonly sites: readonly VersionSite[];
}

/** `"version": "X.Y.Z"` out of package.json text. */
export function readPackageVersion(text: string): string {
	const parsed = JSON.parse(text) as { version?: unknown };
	if (typeof parsed.version !== "string") {
		throw new Error("package.json has no string `version` field");
	}
	return parsed.version;
}

/** `export const VERSION = "X.Y.Z"` out of src/index.ts text. */
export function readIndexVersion(text: string): string {
	const found = /\bconst VERSION = "([^"]+)"/.exec(text);
	if (!found?.[1]) {
		throw new Error('Could not find `const VERSION = "..."` in src/index.ts');
	}
	return found[1];
}

/** `info.version` out of docs/openapi.yaml text. */
export function readOpenapiVersion(text: string): string {
	const doc = parse(text) as { info?: { version?: unknown } } | null;
	const version = doc?.info?.version;
	if (typeof version !== "string") {
		throw new Error("docs/openapi.yaml has no string `info.version`");
	}
	return version;
}

function read(relPath: string, repoRoot: string): string {
	return readFileSync(resolve(repoRoot, relPath), "utf8");
}

/** Read every version site off disk and bucket it into its consistency group. */
export function collectGroups(repoRoot: string = REPO_ROOT): SiteGroup[] {
	const pkgText = read("package.json", repoRoot);
	const readmeText = read("README.md", repoRoot);

	return [
		{
			name: "warren release version",
			sites: [
				{ file: "package.json", where: '"version" field', version: readPackageVersion(pkgText) },
				{
					file: "src/index.ts",
					where: "VERSION constant",
					version: readIndexVersion(read("src/index.ts", repoRoot)),
				},
				{
					file: "docs/openapi.yaml",
					where: "info.version (regenerate with `bun run gen:openapi`)",
					version: readOpenapiVersion(read("docs/openapi.yaml", repoRoot)),
				},
				{
					file: "README.md",
					where: "`## Status` paragraph",
					version: locateReadmeStatusVersion(readmeText).version,
				},
			],
		},
	];
}

export interface GroupDrift {
	readonly group: string;
	readonly canonical: VersionSite;
	readonly mismatches: readonly VersionSite[];
}

/** Sites in each group that disagree with the group's canonical site. */
export function findDrift(groups: readonly SiteGroup[]): GroupDrift[] {
	const drift: GroupDrift[] = [];
	for (const group of groups) {
		const [canonical, ...rest] = group.sites;
		if (canonical === undefined) continue;
		const mismatches = rest.filter((site) => site.version !== canonical.version);
		if (mismatches.length > 0) drift.push({ group: group.name, canonical, mismatches });
	}
	return drift;
}

export function formatDrift(drift: readonly GroupDrift[]): string {
	const lines: string[] = [];
	for (const { group, canonical, mismatches } of drift) {
		lines.push(
			`  ${group} — canonical is ${canonical.version} (${canonical.file}, ${canonical.where}):`,
		);
		for (const site of mismatches) {
			lines.push(`    ${site.file} — ${site.where} says ${site.version}`);
		}
	}
	return lines.join("\n");
}

function main(): void {
	let groups: SiteGroup[];
	try {
		groups = collectGroups();
	} catch (error) {
		console.error(`check:version-sync — ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}

	const drift = findDrift(groups);
	if (drift.length === 0) {
		const summary = groups.map((g) => `${g.name} ${g.sites[0]?.version ?? "?"}`).join(", ");
		console.log(`check:version-sync — ok (${summary})`);
		return;
	}

	const count = drift.reduce((n, d) => n + d.mismatches.length, 0);
	console.error(`check:version-sync — ${count} out-of-sync version site(s):\n`);
	console.error(formatDrift(drift));
	console.error(
		"\nRun `bun run version:bump <major|minor|patch|X.Y.Z>` to rewrite every warren\n" +
			"version site at once.",
	);
	process.exit(1);
}

if (import.meta.main) main();
