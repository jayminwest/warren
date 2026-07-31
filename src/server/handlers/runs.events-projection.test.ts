import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { ANONYMOUS_ACTOR, bearerAuth, OPERATOR_ACTOR, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	buildEnvSecretPattern,
	INTERNAL_EVENT_KINDS,
	projectEvent,
	REDACTED_MARKER,
	scrubSecrets,
} from "./runs/event-projection.ts";
import { CORPUS } from "./runs.events-projection.test-corpus.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./runs.test-helpers.ts";

/**
 * Secret scrubber + public projection for the run event stream
 * (warren-1cb7 / pl-b82d step 16).
 *
 * Asserted twice over, like the run-row projection (warren-946f): as a
 * fixture corpus of real-shaped agent payloads through the pure scrubber,
 * and over the wire against a real server under `WARREN_AUTH=public` —
 * anonymously and with the operator token, so "the operator stream is
 * unchanged" is proved rather than assumed.
 */

const TOKEN = "s3cret";

describe("scrubSecrets — fixture corpus (warren-1cb7)", () => {
	for (const fixture of CORPUS) {
		test(`redacts ${fixture.name}`, () => {
			const scrubbed = JSON.stringify(scrubSecrets(fixture.payload, null));
			expect(scrubbed).not.toContain(fixture.secret);
			expect(scrubbed).toContain(REDACTED_MARKER);
		});
	}

	test("leaves ordinary transcript text untouched", () => {
		const payload = {
			type: "tool_use",
			name: "Bash",
			input: { command: "bun test src/server/projection.test.ts" },
			usage: { input_tokens: 1200, output_tokens: 34 },
			ok: true,
			nothing: null,
		};
		expect(scrubSecrets(payload, null)).toEqual(payload);
	});

	test("leaves an ordinary URL without userinfo untouched", () => {
		const payload = {
			type: "text",
			text: "cloning https://github.com/os-eco/warren.git and GET https://api.example.com:5432/x",
		};
		expect(scrubSecrets(payload, null)).toEqual(payload);
	});

	test("redacts URL userinfo whole but leaves the host readable", () => {
		expect(scrubSecrets("db=postgres://u:pw@host:5432/db", null)).toBe(
			`db=${REDACTED_MARKER}host:5432/db`,
		);
	});

	test("does not mistake an ordinary dotted identifier for a JWT", () => {
		const payload = { type: "text", text: "import foo.bar.baz; module.exports.thing = 1" };
		expect(scrubSecrets(payload, null)).toEqual(payload);
	});

	test("keeps the Authorization header and scheme so the redaction reads as a header", () => {
		const scrubbed = scrubSecrets("curl -H 'Authorization: Bearer abc123def456' x", null);
		expect(scrubbed).toBe(`curl -H 'Authorization: Bearer ${REDACTED_MARKER}' x`);
	});

	test("scrubs every occurrence in one string, not just the first", () => {
		const line =
			"a=ghp_0123456789abcdefghijABCDEFGHIJ0123 b=ghp_9876543210abcdefghijABCDEFGHIJ0123";
		expect(scrubSecrets(line, null)).toBe(`a=${REDACTED_MARKER} b=${REDACTED_MARKER}`);
	});

	test("walks arrays and nested objects", () => {
		const scrubbed = scrubSecrets(
			{ content: [{ text: "AKIAIOSFODNN7EXAMPLE" }, { deep: { text: "AKIAIOSFODNN7EXAMPLE" } }] },
			null,
		);
		expect(JSON.stringify(scrubbed)).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});
});

describe("buildEnvSecretPattern (warren-1cb7)", () => {
	test("redacts a literal instance secret that matches no known shape", () => {
		const pattern = buildEnvSecretPattern({ WARREN_API_TOKEN: "house-token-not-a-shape" });
		expect(scrubSecrets("bearer house-token-not-a-shape", pattern)).toBe(
			`bearer ${REDACTED_MARKER}`,
		);
	});

	test("ignores env names that only point at a secret", () => {
		// `…_NAME` is a k8s Secret's name, not the credential itself.
		expect(
			buildEnvSecretPattern({ WARREN_K8S_ANTHROPIC_SECRET_NAME: "warren-anthropic-key" }),
		).toBeNull();
	});

	test("ignores short values that would mangle the transcript", () => {
		expect(buildEnvSecretPattern({ GITHUB_TOKEN: "abc" })).toBeNull();
	});

	test("redacts the longer value whole when one secret prefixes another", () => {
		const pattern = buildEnvSecretPattern({
			A_TOKEN: "shared-prefix-value",
			B_TOKEN: "shared-prefix-value-extended",
		});
		expect(scrubSecrets("shared-prefix-value-extended", pattern)).toBe(REDACTED_MARKER);
	});

	test("is null when the env carries no secret-shaped name", () => {
		expect(buildEnvSecretPattern({ PATH: "/usr/bin:/bin", WARREN_RUNTIME: "local" })).toBeNull();
	});

	test("redacts a WARREN_DB_URL DSN value that leaks into the transcript", () => {
		const dsn = "postgresql://postgres:pw-in-env@db.proj.supabase.co:5432/postgres";
		const pattern = buildEnvSecretPattern({ WARREN_DB_URL: dsn });
		expect(scrubSecrets(`connecting to ${dsn} now`, pattern)).not.toContain("pw-in-env");
	});

	test("covers *_URI and *_CONN env names as well as *_URL", () => {
		expect(buildEnvSecretPattern({ MONGO_URI: "mongodb://a:secretpw@host/db" })).not.toBeNull();
		expect(buildEnvSecretPattern({ PG_CONN: "host=x password=secretpw12345" })).not.toBeNull();
	});
});

describe("projectEvent (warren-1cb7)", () => {
	const row = {
		kind: "tool_use",
		payloadJson: { input: { command: "echo AKIAIOSFODNN7EXAMPLE" } },
	};

	test("an operator gets the row by reference, untouched", () => {
		expect(projectEvent(row, OPERATOR_ACTOR)).toBe(row);
	});

	test("an absent actor is treated as the operator", () => {
		expect(projectEvent(row, undefined)).toBe(row);
	});

	test("a readPublic-only spectator gets a scrubbed copy", () => {
		const projected = projectEvent(row, ANONYMOUS_ACTOR);
		expect(projected).not.toBeNull();
		expect(JSON.stringify(projected)).not.toContain("AKIAIOSFODNN7EXAMPLE");
		// The stored row is never mutated — the operator stream still reads it.
		expect(row.payloadJson.input.command).toBe("echo AKIAIOSFODNN7EXAMPLE");
	});

	test("internal bridge plumbing is dropped whole", () => {
		for (const kind of INTERNAL_EVENT_KINDS) {
			const internal = { kind, payloadJson: { burrowRunId: "burun_1", burrowId: "bur_1" } };
			expect(projectEvent(internal, ANONYMOUS_ACTOR)).toBeNull();
			expect(projectEvent(internal, undefined)).toBe(internal);
		}
	});

	test("the drop set is exactly the internal handles warren-946f already redacts", () => {
		expect([...INTERNAL_EVENT_KINDS].sort()).toEqual([
			"bridge_fatal",
			"bridge_lost",
			"bridge_recovered",
			"bridge_stalled",
		]);
	});
});

/** A burrow client that 404s everything — no route here reaches it. */
function inertBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(
			async () => new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 }),
		),
	});
}

describe("GET /runs/:id/events under WARREN_AUTH=public (warren-1cb7)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;
	let runId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/data/projects/os-eco/warren",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId: project.id,
			prompt: "fix the flaky test",
			renderedAgentJson: { name: "claude-code" },
			trigger: "manual",
		});
		runId = run.id;
		let seq = 0;
		for (const fixture of CORPUS) {
			seq += 1;
			await repos.events.append({
				runId,
				burrowEventSeq: seq,
				ts: "2026-07-27T12:00:00.000Z",
				kind: "tool_use",
				stream: "stdout",
				payload: fixture.payload,
			});
		}
		seq += 1;
		await repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts: "2026-07-27T12:00:01.000Z",
			kind: "bridge_lost",
			stream: "system",
			payload: { burrowRunId: "burun_1", reason: "burrow_unreachable", finalized: true },
		});
		handle = startServer(await depsFor(repos, inertBurrowClient()), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth(TOKEN)),
			logger: silentLogger,
		});
		base = tcpUrl(handle);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function stream(token?: string): Promise<{ text: string; lines: string[] }> {
		// Explicit follow=0: these tests assert projection over the replayed
		// history. As of warren-7bff a bare request on a non-terminal run
		// follows instead of replay-then-close.
		const res = await fetch(
			`${base}/runs/${runId}/events?follow=0`,
			token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		return { text, lines: text.split("\n").filter((l) => l !== "") };
	}

	test("no fixture secret survives the anonymous stream", async () => {
		const { text } = await stream();
		for (const fixture of CORPUS) {
			expect(text).not.toContain(fixture.secret);
		}
		expect(text).toContain(REDACTED_MARKER);
	});

	test("the anonymous stream drops internal bridge events and nothing else", async () => {
		const { lines } = await stream();
		expect(lines).toHaveLength(CORPUS.length);
		const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
		expect(kinds).not.toContain("bridge_lost");
		expect(new Set(kinds)).toEqual(new Set(["tool_use"]));
	});

	test("a dropped event leaves no blank line on the wire", async () => {
		const { text } = await stream();
		expect(text).not.toContain("\n\n");
		expect(text.endsWith("\n")).toBe(true);
	});

	test("the anonymous envelope keeps its historical shape", async () => {
		const { lines } = await stream();
		const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
		expect(Object.keys(first)).toEqual(["id", "runId", "seq", "ts", "kind", "stream", "payload"]);
		expect(first.seq).toBe(1);
		expect(first.stream).toBe("stdout");
	});

	test("the operator stream is unscrubbed and complete", async () => {
		const { text, lines } = await stream(TOKEN);
		expect(lines).toHaveLength(CORPUS.length + 1);
		expect(text).not.toContain(REDACTED_MARKER);
		for (const fixture of CORPUS) {
			expect(text).toContain(fixture.secret);
		}
		expect(text).toContain("burun_1");
	});
});
