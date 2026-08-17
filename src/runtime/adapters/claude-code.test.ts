/**
 * Ported from burrow's `src/runtime/claude-code.test.ts` (warren-7933).
 * Burrow's DB-row fakes collapse to the narrowed `AdapterSpawnContext` /
 * `SteeringMessage` shapes; the envPassthrough / buildResumeCommand /
 * credentialPaths suites stay behind in burrow (out of the lift's scope).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLAUDE_CODE_SANDBOX_TMPDIR,
	CLAUDE_CODE_SETTINGS_PATH,
	claudeCodeAdapter,
	claudeCodeBurrowTmpdir,
	encodeClaudeStdin,
} from "./claude-code.ts";
import { forwardClaudeHostCredentials } from "./claude-credentials.ts";
import type { AdapterSpawnContext, SteeringMessage } from "./types.ts";

function fakeMessage(extra: Partial<SteeringMessage> = {}): SteeringMessage {
	return {
		body: "stop and write tests first",
		priority: "high",
		...extra,
	};
}

function fakeSpawnContext(extra: Partial<AdapterSpawnContext> = {}): AdapterSpawnContext {
	return {
		runId: "run_test",
		prompt: "hello",
		pendingMessages: [],
		workspacePath: "/ws",
		...extra,
	};
}

describe("claudeCodeAdapter.buildSpawnCommand", () => {
	test("renders stream-json argv with the prompt + steering on stdin", () => {
		const cmd = claudeCodeAdapter.buildSpawnCommand?.(
			fakeSpawnContext({ prompt: "fix the bug", pendingMessages: [fakeMessage()] }),
		);
		expect(cmd?.argv).toEqual([
			"claude",
			"--print",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
		]);
		expect(typeof cmd?.stdin).toBe("string");
		const lines = (cmd?.stdin ?? "").split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({
			type: "user",
			message: { role: "user", content: [{ type: "text", text: "fix the bug" }] },
		});
		expect(lines[1]).toContain("[STEERING]");
		expect(lines[1]).toContain("priority: high");
	});

	test("encodeClaudeStdin omits the prompt line when prompt is empty", () => {
		const blob = encodeClaudeStdin("", [fakeMessage()]);
		expect(blob.split("\n")).toHaveLength(1);
		expect(blob).toContain("[STEERING]");
	});

	test("emits per-run TMPDIR pointing at .sandbox-tmp under the in-sandbox workspace (burrow-8452)", () => {
		const cmd = claudeCodeAdapter.buildSpawnCommand?.(
			fakeSpawnContext({ prompt: "p", workspacePath: "/host/ws" }),
		);
		expect(cmd?.env?.TMPDIR).toBe(claudeCodeBurrowTmpdir("/host/ws"));
	});
});

describe("claudeCodeBurrowTmpdir", () => {
	test("linux resolves under bwrap's /workspace remap, not the host path", () => {
		expect(claudeCodeBurrowTmpdir("/host/ws", "linux")).toBe(
			`/workspace/${CLAUDE_CODE_SANDBOX_TMPDIR}`,
		);
	});

	test("darwin keeps the host workspace path (sandbox-exec doesn't remap)", () => {
		expect(claudeCodeBurrowTmpdir("/Users/u/ws", "darwin")).toBe(
			`/Users/u/ws/${CLAUDE_CODE_SANDBOX_TMPDIR}`,
		);
	});
});

describe("claudeCodeAdapter.encodeInboxMessage", () => {
	test("emits one user-text envelope per message tagged with priority", () => {
		const out = claudeCodeAdapter.encodeInboxMessage?.([
			fakeMessage({ body: "first", priority: "urgent" }),
			fakeMessage({ body: "second", priority: "low" }),
		]);
		const lines = out?.stdin.split("\n") ?? [];
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l));
		expect(parsed[0]?.message.content[0].text).toContain("priority: urgent");
		expect(parsed[1]?.message.content[0].text).toContain("priority: low");
	});
});

describe("claudeCodeAdapter.parseEvents", () => {
	test("delegates to parseJsonlClaude — system envelope becomes state_change/system", () => {
		const events =
			claudeCodeAdapter.parseEvents?.(
				JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
			) ?? [];
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});
});

describe("claudeCodeAdapter stdin-hold surface", () => {
	test("declares no shouldCloseStdinOnEvent — claude-code --print needs stdin EOF to flush", () => {
		// Burrow's runtime contract: runtimes that rely on stdin EOF to
		// flush their final output MUST NOT declare the stdin-hold
		// predicate. Pin the absence so a future edit can't silently flip
		// claude-code onto the pi-style hold and truncate every run.
		expect(claudeCodeAdapter.shouldCloseStdinOnEvent).toBeUndefined();
		expect(claudeCodeAdapter.encodeSteeringMessage).toBeUndefined();
	});
});

describe("claudeCodeAdapter.prepareWorkspace", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "warren-claude-prep-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("writes a default .claude/settings.local.json", async () => {
		await claudeCodeAdapter.prepareWorkspace?.({ runId: "run_test", workspacePath: dir });
		const body = await readFile(join(dir, CLAUDE_CODE_SETTINGS_PATH), "utf8");
		const parsed = JSON.parse(body);
		expect(parsed).toMatchObject({ permissions: {}, hooks: {} });
	});

	test("plants .sandbox-tmp/ + a `*` .gitignore (burrow-8452)", async () => {
		await claudeCodeAdapter.prepareWorkspace?.({ runId: "run_test", workspacePath: dir });
		const fs = await import("node:fs");
		const tmpDir = join(dir, CLAUDE_CODE_SANDBOX_TMPDIR);
		expect(fs.statSync(tmpDir).isDirectory()).toBe(true);
		expect(await readFile(join(tmpDir, ".gitignore"), "utf8")).toBe("*\n");
	});
});

describe("forwardClaudeHostCredentials (linux)", () => {
	let workspaceDir: string;
	let fakeHome: string;
	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "warren-claude-prep-"));
		fakeHome = await mkdtemp(join(tmpdir(), "warren-claude-home-"));
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	test("copies host ~/.claude/.credentials.json into the run's .claude/ when present", async () => {
		const fs = await import("node:fs/promises");
		await fs.mkdir(join(fakeHome, ".claude"), { recursive: true });
		await writeFile(join(fakeHome, ".claude", ".credentials.json"), '{"token":"fake"}');

		await forwardClaudeHostCredentials(workspaceDir, { home: fakeHome, plat: "linux" });

		const forwarded = await readFile(join(workspaceDir, ".claude", ".credentials.json"), "utf8");
		expect(JSON.parse(forwarded)).toEqual({ token: "fake" });
	});

	test("is a no-op when the host has no ~/.claude/.credentials.json", async () => {
		await forwardClaudeHostCredentials(workspaceDir, { home: fakeHome, plat: "linux" });
		const fs = await import("node:fs");
		expect(fs.existsSync(join(workspaceDir, ".claude", ".credentials.json"))).toBe(false);
	});
});

describe("forwardClaudeHostCredentials (darwin)", () => {
	let workspaceDir: string;
	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "warren-claude-prep-"));
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
	});

	test("extracts the Keychain blob and writes it as .credentials.json", async () => {
		const blob = '{"claudeAiOauth":{"accessToken":"oat-x","refreshToken":"rt-y"}}';
		await forwardClaudeHostCredentials(workspaceDir, {
			plat: "darwin",
			keychainReader: async (service) => {
				expect(service).toBe("Claude Code-credentials");
				return blob;
			},
		});
		const written = await readFile(join(workspaceDir, ".claude", ".credentials.json"), "utf8");
		expect(written).toBe(blob);
	});

	test("is a no-op when Keychain has no entry", async () => {
		await forwardClaudeHostCredentials(workspaceDir, {
			plat: "darwin",
			keychainReader: async () => null,
		});
		const fs = await import("node:fs");
		expect(fs.existsSync(join(workspaceDir, ".claude", ".credentials.json"))).toBe(false);
	});
});
