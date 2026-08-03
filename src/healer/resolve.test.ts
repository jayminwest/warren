import { describe, expect, test } from "bun:test";
import type { HealAlert } from "./alert.ts";
import { type HealProjectCandidate, healMappingKeyMatches, resolveHealProject } from "./resolve.ts";

function alert(over: Partial<HealAlert> = {}): HealAlert {
	return {
		fingerprint: "fp-1",
		title: "HighErrorRate",
		culprit: "src/runs/reap.ts",
		detail: null,
		links: [],
		source: "grafana",
		repo: null,
		...over,
	};
}

function candidate(over: Partial<HealProjectCandidate> = {}): HealProjectCandidate {
	return {
		projectId: "prj_1",
		gitUrl: "https://github.com/jayminwest/warren.git",
		localPath: "/data/projects/jayminwest/warren",
		settings: { enabled: true, maxRetries: 3, cooldownMinutes: 30 },
		role: "healer",
		projectMapping: [],
		...over,
	};
}

describe("resolveHealProject", () => {
	test("matches a static mapping key on the fingerprint", () => {
		const c = candidate({ projectMapping: ["fp-1"] });
		const result = resolveHealProject(alert(), [c]);
		expect(result).toEqual({ kind: "matched", candidate: c });
	});

	test("matches a static mapping key against the whole culprit (case-insensitive)", () => {
		const c = candidate({ projectMapping: ["SRC/RUNS/REAP.TS"] });
		expect(resolveHealProject(alert(), [c]).kind).toBe("matched");
	});

	test("matches a static mapping key against the whole title", () => {
		const c = candidate({ projectMapping: ["higherrorrate"] });
		expect(resolveHealProject(alert(), [c]).kind).toBe("matched");
	});

	// warren-50a7: a short key used to substring-match unrelated alerts.
	test("does not match a short key that is only a fragment of the alert", () => {
		const c = candidate({ projectMapping: ["api"], gitUrl: "https://github.com/x/y.git" });
		const unrelated = alert({ title: "Rapid API latency spike", culprit: "svc/api/handler.ts" });
		expect(resolveHealProject(unrelated, [c]).kind).toBe("no_match");
	});

	test("matches an explicit trailing-wildcard key as a prefix", () => {
		const c = candidate({ projectMapping: ["src/runs/*"] });
		expect(resolveHealProject(alert(), [c]).kind).toBe("matched");
	});

	test("matches an explicit leading-wildcard key as a suffix", () => {
		const c = candidate({ projectMapping: ["*ErrorRate"] });
		expect(resolveHealProject(alert(), [c]).kind).toBe("matched");
	});

	test("falls back to repo match against the project git URL", () => {
		const c = candidate({ projectMapping: [] });
		const result = resolveHealProject(alert({ repo: "jayminwest/warren" }), [c]);
		expect(result).toEqual({ kind: "matched", candidate: c });
	});

	test("mapping wins over repo fallback", () => {
		const mapped = candidate({ projectId: "prj_mapped", projectMapping: ["fp-1"] });
		const repoOnly = candidate({
			projectId: "prj_repo",
			projectMapping: [],
			gitUrl: "https://github.com/jayminwest/warren.git",
		});
		const result = resolveHealProject(alert({ repo: "jayminwest/warren" }), [repoOnly, mapped]);
		expect(result.kind).toBe("matched");
		if (result.kind === "matched") expect(result.candidate.projectId).toBe("prj_mapped");
	});

	test("treats regex metacharacters in a key as literals", () => {
		const c = candidate({
			projectMapping: ["src/runs/reap.ts"],
			gitUrl: "https://github.com/x/y.git",
		});
		// `.` must not act as "any char": a differing char at that position misses.
		expect(resolveHealProject(alert({ culprit: "src/runs/reapXts" }), [c]).kind).toBe("no_match");
	});

	test("reports no_match when nothing routes", () => {
		const c = candidate({ projectMapping: ["other"], gitUrl: "https://github.com/x/y.git" });
		expect(resolveHealProject(alert({ repo: null }), [c]).kind).toBe("no_match");
	});

	test("a catch-all '*' key routes every alert", () => {
		const c = candidate({ projectMapping: ["*"], gitUrl: "https://github.com/x/y.git" });
		expect(resolveHealProject(alert({ title: "anything at all" }), [c]).kind).toBe("matched");
	});

	test("reports not_enabled when a match exists but the project is opted out", () => {
		const c = candidate({
			settings: { enabled: false, maxRetries: 3, cooldownMinutes: 30 },
			projectMapping: ["fp-1"],
		});
		expect(resolveHealProject(alert(), [c]).kind).toBe("not_enabled");
	});

	test("ignores disabled projects when an enabled one also matches", () => {
		const disabled = candidate({
			projectId: "prj_off",
			settings: { enabled: false, maxRetries: 3, cooldownMinutes: 30 },
			projectMapping: ["fp-1"],
		});
		const enabled = candidate({ projectId: "prj_on", projectMapping: ["fp-1"] });
		const result = resolveHealProject(alert(), [disabled, enabled]);
		expect(result.kind).toBe("matched");
		if (result.kind === "matched") expect(result.candidate.projectId).toBe("prj_on");
	});
});

describe("healMappingKeyMatches", () => {
	test("requires a full, case-insensitive match without wildcards", () => {
		expect(healMappingKeyMatches("api", "api")).toBe(true);
		expect(healMappingKeyMatches("API", "api")).toBe(true);
		expect(healMappingKeyMatches("api", "payments-api")).toBe(false);
		expect(healMappingKeyMatches("api", "api-gateway")).toBe(false);
	});

	test("widens on explicit wildcards only", () => {
		expect(healMappingKeyMatches("api*", "api-gateway")).toBe(true);
		expect(healMappingKeyMatches("*api", "payments-api")).toBe(true);
		expect(healMappingKeyMatches("pay*service", "payments-api-service")).toBe(true);
		expect(healMappingKeyMatches("pay*service", "payments-api")).toBe(false);
	});
});
