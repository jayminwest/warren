import { describe, expect, test } from "bun:test";

import {
	type ClientOptions,
	formatSummary,
	isAlreadyExists,
	type Outcome,
	parseArgs,
	parseRepoFile,
	planRegistrations,
	registerOne,
	repoKey,
} from "./register-projects.ts";

// The property under test throughout is IDEMPOTENCE. This script exists to be
// re-run after a partial failure (a clone that timed out mid-batch), so every
// path that could double-register or abort a resume is covered here.

/** A `fetch` stub that records calls and replays a scripted response queue. */
function stubFetch(responses: { status: number; body: unknown }[]) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const impl = (async (url: string | URL | Request, init?: RequestInit) => {
		const next = responses.shift();
		if (!next) throw new Error(`unexpected extra fetch to ${String(url)}`);
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		});
		return new Response(next.body === null ? "" : JSON.stringify(next.body), {
			status: next.status,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { impl, calls };
}

function opts(fetchImpl: typeof fetch): ClientOptions {
	return { baseUrl: "https://warren.test", token: "t0ken", fetchImpl };
}

describe("repoKey normalizes past URL spelling", () => {
	test("the .git suffix does not create a second identity", () => {
		expect(repoKey("https://github.com/jayminwest/warren.git")).toBe(
			repoKey("https://github.com/jayminwest/warren"),
		);
	});

	test("owner case does not create a second identity", () => {
		expect(repoKey("https://github.com/JayminWest/Warren")).toBe("jayminwest/warren");
	});
});

describe("planRegistrations", () => {
	const targets = ["https://github.com/jayminwest/warren", "https://github.com/jayminwest/burrow"];

	test("skips what the instance already holds", () => {
		const plan = planRegistrations(targets, [{ gitUrl: "https://github.com/jayminwest/warren" }]);
		expect(plan.toRegister).toEqual(["https://github.com/jayminwest/burrow"]);
		expect(plan.skipped).toEqual(["https://github.com/jayminwest/warren"]);
	});

	test("matches existing rows across spellings — warren's own findByGitUrl does not", () => {
		// The db compares gitUrl by exact string, so a row stored with .git
		// would NOT block a re-register of the bare URL. This is the guard.
		const plan = planRegistrations(targets, [
			{ gitUrl: "https://github.com/jayminwest/warren.git" },
		]);
		expect(plan.toRegister).toEqual(["https://github.com/jayminwest/burrow"]);
	});

	test("a duplicate inside the manifest clones once, not twice", () => {
		const plan = planRegistrations(
			["https://github.com/jayminwest/warren", "https://github.com/jayminwest/warren.git"],
			[],
		);
		expect(plan.toRegister).toHaveLength(1);
		expect(plan.skipped).toHaveLength(1);
	});

	test("an empty instance registers everything given", () => {
		const targets = ["https://github.com/a/b", "https://github.com/c/d"];
		expect(planRegistrations(targets, []).toRegister).toHaveLength(2);
	});
});

describe("parseArgs", () => {
	// No built-in manifest: this script ships in every warren checkout, so a
	// default list would be one deployment's repos in everyone else's tree.
	test("no arguments yields no repos — there is no default list", () => {
		expect(parseArgs([]).repos).toEqual([]);
	});

	test("repos come from the caller", () => {
		expect(parseArgs(["https://github.com/a/b"]).repos).toEqual(["https://github.com/a/b"]);
	});

	test("--dry-run is a flag, not a repo", () => {
		const args = parseArgs(["--dry-run", "https://github.com/a/b"]);
		expect(args.dryRun).toBe(true);
		expect(args.repos).toEqual(["https://github.com/a/b"]);
	});

	test("--from captures its path and does not treat it as a repo", () => {
		const args = parseArgs(["--from", "repos.txt", "https://github.com/a/b"]);
		expect(args.fromFile).toBe("repos.txt");
		expect(args.repos).toEqual(["https://github.com/a/b"]);
	});
});

describe("parseRepoFile", () => {
	test("one url per line, ignoring blanks and # comments", () => {
		expect(
			parseRepoFile("# my instance\nhttps://github.com/a/b\n\n  https://github.com/c/d  \n"),
		).toEqual(["https://github.com/a/b", "https://github.com/c/d"]);
	});
});

describe("isAlreadyExists", () => {
	test("warren's duplicate 400 reads as a skip", () => {
		expect(
			isAlreadyExists(400, {
				error: { code: "validation_error", message: "project already exists: p-123" },
			}),
		).toBe(true);
	});

	test("an unrelated 400 is a real failure", () => {
		expect(
			isAlreadyExists(400, { error: { code: "validation_error", message: "gitUrl is empty" } }),
		).toBe(false);
	});

	test("a 500 is never a skip", () => {
		expect(isAlreadyExists(500, { error: { code: "internal_error" } })).toBe(false);
	});
});

describe("registerOne", () => {
	test("registers with a single POST /projects — no agent-refresh follow-up", async () => {
		// The agent registry is inline (pl-3a79); the per-project refresh route
		// is gone, so a registration is exactly one call.
		const { impl, calls } = stubFetch([{ status: 201, body: { id: "p-1" } }]);
		const out = await registerOne(opts(impl), "https://github.com/jayminwest/warren");
		expect(out.state).toBe("registered");
		expect(out.id).toBe("p-1");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe("https://warren.test/projects");
		expect(calls[0]?.body).toEqual({ gitUrl: "https://github.com/jayminwest/warren" });
	});

	test("a duplicate mid-run is a skip, so a resume does not fail", async () => {
		const { impl } = stubFetch([
			{
				status: 400,
				body: { error: { code: "validation_error", message: "project already exists: p-9" } },
			},
		]);
		const out = await registerOne(opts(impl), "https://github.com/jayminwest/warren");
		expect(out.state).toBe("skipped");
	});

	test("a real error is reported with its code and message", async () => {
		const { impl } = stubFetch([
			{ status: 500, body: { error: { code: "internal_error", message: "boom" } } },
		]);
		const out = await registerOne(opts(impl), "https://github.com/jayminwest/warren");
		expect(out.state).toBe("failed");
		expect(out.detail).toContain("internal_error");
	});

	test("a 201 without an id fails loudly", async () => {
		const { impl } = stubFetch([{ status: 201, body: {} }]);
		const out = await registerOne(opts(impl), "https://github.com/jayminwest/warren");
		expect(out.state).toBe("failed");
	});

	test("a transport error is caught, not thrown into the batch loop", async () => {
		const impl = (async () => {
			throw new Error("timed out");
		}) as unknown as typeof fetch;
		const out = await registerOne(opts(impl), "https://github.com/jayminwest/warren");
		expect(out.state).toBe("failed");
		expect(out.detail).toContain("timed out");
	});
});

describe("formatSummary", () => {
	test("counts each state and marks failures", () => {
		const outcomes: Outcome[] = [
			{ gitUrl: "a", state: "registered" },
			{ gitUrl: "b", state: "skipped" },
			{ gitUrl: "c", state: "failed", detail: "HTTP 500" },
		];
		const summary = formatSummary(outcomes);
		expect(summary).toContain("1 registered, 1 skipped, 1 failed");
		expect(summary).toContain("✗ c");
	});
});
