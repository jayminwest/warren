import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type Allowlist,
	BEGIN_MARKER,
	compareHits,
	compareToBase,
	countPluginHits,
	END_MARKER,
	type HitCounts,
	parseAllowlist,
	renderSection,
	spliceSection,
} from "./check-ui-raw-elements.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const RUNS = "src/ui/src/pages/runs.tsx";
const LOGIN = "src/ui/src/pages/login.tsx";

function allowlist(raw: Partial<Allowlist> = {}): Allowlist {
	return { "no-raw-form-elements": {}, "no-inline-style": {}, ...raw };
}

function hits(raw: Partial<Record<keyof Allowlist, [string, number][]>> = {}): HitCounts {
	return {
		"no-raw-form-elements": new Map(raw["no-raw-form-elements"] ?? []),
		"no-inline-style": new Map(raw["no-inline-style"] ?? []),
	};
}

describe("parseAllowlist", () => {
	test("accepts a well-formed allowlist", () => {
		const { allowlist: parsed, errors } = parseAllowlist({
			rules: { "no-raw-form-elements": { [RUNS]: { tracker: "warren-23b5", max: 2 } } },
		});
		expect(errors).toEqual([]);
		expect(parsed["no-raw-form-elements"][RUNS]).toEqual({ tracker: "warren-23b5", max: 2 });
	});

	test("rejects unknown rules, out-of-scope paths, missing trackers, and bad ceilings", () => {
		const { errors, allowlist: parsed } = parseAllowlist({
			rules: {
				"no-divs": {},
				"no-inline-style": {
					"src/server/main.ts": { tracker: "warren-23b5", max: 1 },
					"src/ui/src/components/ui/button.tsx": { tracker: "warren-23b5", max: 1 },
					[RUNS]: { tracker: "none", max: 1 },
					[LOGIN]: { tracker: "warren-23b5", max: 0 },
				},
			},
		});
		expect(errors.join("\n")).toContain('unknown rule "no-divs"');
		expect(errors.join("\n")).toContain("src/server/main.ts: path must be a .tsx file");
		expect(errors.join("\n")).toContain("components/ui/ is exempt already");
		expect(errors.join("\n")).toContain(`${RUNS}: tracker must be`);
		expect(errors.join("\n")).toContain(`${LOGIN}: max must be a positive integer`);
		expect(parsed["no-inline-style"]).toEqual({});
	});

	test("rejects a file without a rules object", () => {
		expect(parseAllowlist({}).errors).toEqual(["allowlist must have a `rules` object"]);
	});
});

describe("renderSection and spliceSection", () => {
	test("exclude every grandfathered file per rule and keep components/ui exempt", () => {
		const section = renderSection(
			allowlist({ "no-inline-style": { [LOGIN]: { tracker: "warren-23b5", max: 3 } } }),
		);
		expect(section).toContain('"!src/ui/src/components/ui/**"');
		expect(section).toContain(`"!${LOGIN}"`);
		expect(section).toContain('"plugins": ["./.biome/plugins/no-inline-style.grit"]');
		expect(section).toContain('"plugins": ["./.biome/plugins/no-raw-form-elements.grit"]');
	});

	test("replace only the marker-delimited block", () => {
		const config = `{\n\t"overrides": [\n\t\t${BEGIN_MARKER}\n\t\t{ "old": 1 },\n\t\t${END_MARKER}\n\t\t{ "kept": 1 }\n\t]\n}\n`;
		const out = spliceSection(config, renderSection(allowlist()));
		expect(out).not.toContain('"old"');
		expect(out).toContain('{ "kept": 1 }');
		expect(spliceSection(out, renderSection(allowlist()))).toBe(out);
	});

	test("throw when the markers are missing", () => {
		expect(() => spliceSection("{}", "x")).toThrow(/missing/);
	});
});

describe("compareHits", () => {
	const listed = allowlist({
		"no-raw-form-elements": {
			[RUNS]: { tracker: "warren-23b5", max: 2 },
			[LOGIN]: { tracker: "warren-23b5", max: 2 },
		},
		"no-inline-style": { [LOGIN]: { tracker: "warren-23b5", max: 5 } },
	});

	test("pass when every entry matches its ceiling", () => {
		const result = compareHits(
			listed,
			hits({
				"no-raw-form-elements": [
					[RUNS, 2],
					[LOGIN, 2],
				],
				"no-inline-style": [[LOGIN, 5]],
			}),
		);
		expect(result.problems).toEqual([]);
		expect(result.tightened).toEqual(listed);
	});

	test("fail stale, over-ceiling, and under-ceiling entries and tighten the ceilings", () => {
		const result = compareHits(
			listed,
			hits({ "no-raw-form-elements": [[RUNS, 3]], "no-inline-style": [[LOGIN, 1]] }),
		);
		expect(result.problems).toEqual([
			`no-raw-form-elements → ${RUNS}: 3 hits exceed the grandfathered max 2`,
			`no-raw-form-elements → ${LOGIN}: stale entry, no hits remain; remove it`,
			`no-inline-style → ${LOGIN}: 1 hits, lower max from 5 to 1`,
		]);
		expect(result.tightened["no-raw-form-elements"]).toEqual({
			[RUNS]: { tracker: "warren-23b5", max: 2 },
		});
		expect(result.tightened["no-inline-style"][LOGIN]?.max).toBe(1);
	});
});

describe("compareToBase", () => {
	const base = allowlist({ "no-inline-style": { [LOGIN]: { tracker: "warren-23b5", max: 3 } } });

	test("allow removals and lowered ceilings", () => {
		expect(compareToBase(allowlist(), base)).toEqual([]);
		const lowered = allowlist({
			"no-inline-style": { [LOGIN]: { tracker: "warren-23b5", max: 1 } },
		});
		expect(compareToBase(lowered, base)).toEqual([]);
	});

	test("fail new entries and raised ceilings", () => {
		const grown = allowlist({
			"no-inline-style": { [LOGIN]: { tracker: "warren-23b5", max: 4 } },
			"no-raw-form-elements": { [RUNS]: { tracker: "warren-23b5", max: 1 } },
		});
		expect(compareToBase(grown, base)).toEqual([
			`no-raw-form-elements → ${RUNS}: new grandfathered entry; fix the file instead`,
			`no-inline-style → ${LOGIN}: max raised from 3 to 4`,
		]);
	});
});

describe("countPluginHits", () => {
	test("count plugin diagnostics per file and ignore other categories", () => {
		const report = {
			diagnostics: [
				{ category: "plugin", location: { path: RUNS } },
				{ category: "plugin", location: { path: RUNS } },
				{ category: "lint/style/useConst", location: { path: LOGIN } },
			],
		};
		const counts = countPluginHits(`warning line\n${JSON.stringify(report)}\n`);
		expect(counts.get(RUNS)).toBe(2);
		expect(counts.has(LOGIN)).toBe(false);
	});

	test("throw when biome printed no JSON report", () => {
		expect(() => countPluginHits("boom")).toThrow(/no JSON report/);
	});
});

describe("repo state", () => {
	test("the checked-in biome.jsonc block matches the checked-in allowlist", () => {
		const raw = JSON.parse(
			readFileSync(resolve(REPO_ROOT, "scripts/ui-raw-elements-allowlist.json"), "utf8"),
		) as unknown;
		const { allowlist: parsed, errors } = parseAllowlist(raw);
		expect(errors).toEqual([]);
		const config = readFileSync(resolve(REPO_ROOT, "biome.jsonc"), "utf8");
		expect(spliceSection(config, renderSection(parsed))).toBe(config);
	});
});
