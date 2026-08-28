/**
 * Contract guard for the profile-data PR body (warren-e361, plan pl-096b).
 *
 * Acceptance for warren-e361: a grep of the extension `src/` finds no
 * literal section-heading strings outside `profiles/` and the golden
 * fixtures. This test is that grep: it reads the committed contracts from
 * `profiles/` and fails if any rendered heading or template text leaks
 * back into source. The intender must declare no headings of its own.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const PROFILES = join(ROOT, "profiles");
const GOLDEN_DIR = join(SRC, "pr-intent", "__golden__");

/** Every profile artifact that may legitimately carry contract wording. */
function contractFiles(): string[] {
	return readdirSync(PROFILES)
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(PROFILES, name));
}

function walkSource(dir: string, into: string[]): void {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (path === GOLDEN_DIR) continue; // fixtures are allowed
			walkSource(path, into);
		} else if (name.endsWith(".ts")) {
			into.push(path);
		}
	}
}

describe("pr-body contract as data", () => {
	test("no profile contract wording leaks into extension source", async () => {
		// Forbidden in source: every rendered `## <heading>` form, every
		// multi-word bare heading, and every contract template verbatim.
		const forbidden = new Set<string>();
		const addHeadings = (headings: (string | null)[]) => {
			for (const heading of headings) {
				if (heading === null) continue;
				forbidden.add(`## ${heading}`);
				if (heading.includes(" ")) forbidden.add(heading);
			}
		};
		const contract = (await Bun.file(join(PROFILES, "default.pr-body-contract.json")).json()) as {
			sections: { heading: string | null }[];
		};
		addHeadings(contract.sections.map((section) => section.heading));
		for (const path of contractFiles()) {
			const profile = (await Bun.file(path).json()) as {
				prBodyContract?: {
					sections: { heading: string | null }[];
					disclosureTemplate: string;
					footerTemplate: string;
				};
			};
			const c = profile.prBodyContract;
			if (!c) continue;
			addHeadings(c.sections.map((section) => section.heading));
			forbidden.add(c.disclosureTemplate);
			forbidden.add(c.footerTemplate);
		}
		const sources: string[] = [];
		walkSource(SRC, sources);
		const offenders: string[] = [];
		for (const path of sources) {
			const text = readFileSync(path, "utf8");
			for (const needle of forbidden) {
				if (text.includes(needle)) offenders.push(`${path}: ${needle.slice(0, 60)}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the shipped default contract validates against the policy schema", async () => {
		const { validatePrBodyContract } = await import("../repository-policy.ts");
		const contract = validatePrBodyContract(
			JSON.parse(readFileSync(join(PROFILES, "default.pr-body-contract.json"), "utf8")),
			"default pr-body contract",
		);
		expect(contract.version).toBe(1);
		expect(contract.sections.length).toBeGreaterThan(0);
	});

	test("the openclaw profile's contract renders the exact live-gate golden body", async () => {
		const profile = JSON.parse(
			readFileSync(join(PROFILES, "openclaw.repository-policy.json"), "utf8"),
		) as {
			prBodyContract: { sections: { key: string; heading: string | null; required: boolean }[] };
		};
		const contract = profile.prBodyContract;
		// Every content section carries a non-null heading and is required: the
		// openclaw CI gate (openclaw#131131) rejects a body missing any section.
		const contentKeys = [
			"closes",
			"disclosure",
			"problem",
			"solution",
			"userImpact",
			"evidence",
			"runReference",
			"operatorNotes",
		];
		for (const key of contentKeys) {
			const section = contract.sections.find((entry) => entry.key === key);
			expect(section, key).toBeDefined();
			expect(section?.required, key).toBe(true);
		}
		// The openclaw golden pins the exact body that passed the live gate;
		// every profile heading must render into it.
		const golden = JSON.parse(
			readFileSync(join(GOLDEN_DIR, "openclaw-pr-intent.json"), "utf8"),
		) as { request: { body: { body: string } } };
		const goldenBody = golden.request.body.body;
		for (const section of contract.sections) {
			if (section.heading !== null) {
				expect(goldenBody).toContain(`## ${section.heading}`);
			}
		}
	});
});
