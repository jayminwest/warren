/**
 * Ported from burrow's `src/runtime/pi.test.ts` (warren-7933) — the argv /
 * stdin-encoding half. Workspace-hook and steering-predicate tests live in
 * `./pi-hooks.test.ts` (file-size budget). Burrow's DB-row fakes collapse
 * to the narrowed `AdapterSpawnContext` / `SteeringMessage` shapes.
 */

import { describe, expect, test } from "bun:test";
import { piAdapter } from "./pi.ts";
import {
	buildPiArgv,
	PI_DEFAULT_MODEL,
	PI_DEFAULT_PROVIDER,
	PI_FORCED_ARGV,
	PI_FORCED_ARGV_WITH_EXTENSIONS,
	PI_SESSION_DIR,
} from "./pi-argv.ts";
import { encodePiStdin } from "./pi-stdin.ts";
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
		runId: "run_pi",
		prompt: "hello",
		pendingMessages: [],
		workspacePath: "/ws",
		...extra,
	};
}

describe("piAdapter.buildSpawnCommand", () => {
	test("renders the locked argv prefix and pins the model", () => {
		const cmd = piAdapter.buildSpawnCommand?.(fakeSpawnContext({ prompt: "fix the bug" }));
		// Argv prefix is locked — any drop of these flags re-introduces the
		// Gemini-default / interactive-extension / session-persistence
		// hazards documented in ./pi-argv.ts.
		expect(cmd?.argv.slice(0, PI_FORCED_ARGV.length)).toEqual([...PI_FORCED_ARGV]);
		const modelIdx = cmd?.argv.indexOf("--model") ?? -1;
		expect(modelIdx).toBeGreaterThan(-1);
		expect(cmd?.argv[modelIdx + 1]).toBe(PI_DEFAULT_MODEL);
	});

	test("PI_FORCED_ARGV is the exact frozen prefix (regression guard)", () => {
		// Frozen list — bumping requires verifying the new flag set against
		// pi's RPC behavior and regenerating the golden fixtures. The
		// trailing 'anthropic' slot is the default provider that
		// buildPiArgv swaps out when ctx.frontmatter.provider is set.
		expect(PI_DEFAULT_PROVIDER).toBe("anthropic");
		expect([...PI_FORCED_ARGV]).toEqual([
			"pi",
			"--mode",
			"rpc",
			"--session-dir",
			PI_SESSION_DIR,
			"--no-extensions",
			"--offline",
			"--provider",
			PI_DEFAULT_PROVIDER,
		]);
	});

	test("session-dir is the per-run .pi/sessions path (resume storage)", () => {
		expect(PI_SESSION_DIR).toBe(".pi/sessions");
		const cmd = piAdapter.buildSpawnCommand?.(fakeSpawnContext({ prompt: "p" }));
		const idx = cmd?.argv.indexOf("--session-dir") ?? -1;
		expect(idx).toBeGreaterThan(-1);
		expect(cmd?.argv[idx + 1]).toBe(PI_SESSION_DIR);
		expect(cmd?.argv).not.toContain("--no-session");
	});

	test("stdin carries a single RPC prompt command for a plain prompt", () => {
		const cmd = piAdapter.buildSpawnCommand?.(fakeSpawnContext({ prompt: "fix the bug" }));
		expect(typeof cmd?.stdin).toBe("string");
		expect(cmd?.stdin?.endsWith("\n")).toBe(true);
		const lines = (cmd?.stdin ?? "").split("\n").slice(0, -1);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			type: "prompt",
			message: "fix the bug",
		});
	});

	test("prepends each pending steering message as its own RPC prompt command", () => {
		const cmd = piAdapter.buildSpawnCommand?.(
			fakeSpawnContext({ prompt: "fix the bug", pendingMessages: [fakeMessage()] }),
		);
		expect(cmd?.stdin?.endsWith("\n")).toBe(true);
		const lines = (cmd?.stdin ?? "").split("\n").slice(0, -1);
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0] ?? "") as { message: string };
		const second = JSON.parse(lines[1] ?? "") as { message: string };
		expect(first.message).toBe("fix the bug");
		expect(second.message).toContain("[STEERING]");
		expect(second.message).toContain("priority: high");
		expect(second.message).toContain("stop and write tests first");
	});

	test("does not set custom env or cwd (the sandbox owns those)", () => {
		const cmd = piAdapter.buildSpawnCommand?.(fakeSpawnContext({ prompt: "p" }));
		expect(cmd?.env).toBeUndefined();
		expect(cmd?.cwd).toBeUndefined();
	});
});

describe("piAdapter.buildSpawnCommand frontmatter override (burrow-b5b4)", () => {
	// Warren passes `runs.rendered_agent_json.frontmatter.{provider,model}` —
	// pi substitutes the override for its pinned defaults. Empty /
	// whitespace values fall back to PI_DEFAULT_PROVIDER + PI_DEFAULT_MODEL
	// so a frontmatter envelope that didn't fill a field doesn't
	// accidentally emit `--provider ""`.
	test("substitutes provider + model when both frontmatter fields are set", () => {
		const cmd = piAdapter.buildSpawnCommand?.(
			fakeSpawnContext({
				prompt: "p",
				frontmatter: { provider: "openai", model: "gpt-4o" },
			}),
		);
		const providerIdx = cmd?.argv.indexOf("--provider") ?? -1;
		expect(providerIdx).toBeGreaterThan(-1);
		expect(cmd?.argv[providerIdx + 1]).toBe("openai");
		const modelIdx = cmd?.argv.indexOf("--model") ?? -1;
		expect(cmd?.argv[modelIdx + 1]).toBe("gpt-4o");
	});

	test("model override alone keeps the default provider slot", () => {
		const cmd = piAdapter.buildSpawnCommand?.(
			fakeSpawnContext({ prompt: "p", frontmatter: { model: "claude-opus-4-7" } }),
		);
		const providerIdx = cmd?.argv.indexOf("--provider") ?? -1;
		expect(cmd?.argv[providerIdx + 1]).toBe(PI_DEFAULT_PROVIDER);
		const modelIdx = cmd?.argv.indexOf("--model") ?? -1;
		expect(cmd?.argv[modelIdx + 1]).toBe("claude-opus-4-7");
	});

	test("provider override alone keeps the default model", () => {
		const cmd = piAdapter.buildSpawnCommand?.(
			fakeSpawnContext({ prompt: "p", frontmatter: { provider: "openai" } }),
		);
		const providerIdx = cmd?.argv.indexOf("--provider") ?? -1;
		expect(cmd?.argv[providerIdx + 1]).toBe("openai");
		const modelIdx = cmd?.argv.indexOf("--model") ?? -1;
		expect(cmd?.argv[modelIdx + 1]).toBe(PI_DEFAULT_MODEL);
	});

	test("empty / whitespace frontmatter values fall back to defaults", () => {
		const cmd = piAdapter.buildSpawnCommand?.(
			fakeSpawnContext({ prompt: "p", frontmatter: { provider: "   ", model: "" } }),
		);
		// Whole argv collapses to the no-override shape — guard the prefix
		// equality so a future change can't silently emit `--provider ""`.
		expect(cmd?.argv.slice(0, PI_FORCED_ARGV.length)).toEqual([...PI_FORCED_ARGV]);
		const modelIdx = cmd?.argv.indexOf("--model") ?? -1;
		expect(cmd?.argv[modelIdx + 1]).toBe(PI_DEFAULT_MODEL);
	});

	test("undefined frontmatter is a no-op", () => {
		const cmd = piAdapter.buildSpawnCommand?.(fakeSpawnContext({ prompt: "p" }));
		expect(cmd?.argv).toEqual([...PI_FORCED_ARGV, "--model", PI_DEFAULT_MODEL]);
	});
});

describe("buildPiArgv", () => {
	test("matches PI_FORCED_ARGV + default model with no frontmatter", () => {
		expect(buildPiArgv()).toEqual([...PI_FORCED_ARGV, "--model", PI_DEFAULT_MODEL]);
	});

	test("trims surrounding whitespace from provider + model overrides", () => {
		const argv = buildPiArgv({ provider: "  openai  ", model: "\tgpt-4o\n" });
		const providerIdx = argv.indexOf("--provider");
		expect(argv[providerIdx + 1]).toBe("openai");
		const modelIdx = argv.indexOf("--model");
		expect(argv[modelIdx + 1]).toBe("gpt-4o");
	});

	test("PI_FORCED_ARGV_WITH_EXTENSIONS is PI_FORCED_ARGV minus --no-extensions (burrow-12ba)", () => {
		// Locked sibling — same flags as the plain-pi prefix with the single
		// `--no-extensions` entry elided so a runtime that can answer pi's
		// interactive `extension_ui_request` RPC renders with extensions
		// enabled. Asserted here to keep the two constants in lockstep.
		expect([...PI_FORCED_ARGV_WITH_EXTENSIONS]).toEqual([
			"pi",
			"--mode",
			"rpc",
			"--session-dir",
			PI_SESSION_DIR,
			"--offline",
			"--provider",
			PI_DEFAULT_PROVIDER,
		]);
		expect([...PI_FORCED_ARGV_WITH_EXTENSIONS]).toEqual(
			PI_FORCED_ARGV.filter((flag) => flag !== "--no-extensions"),
		);
	});

	test("extensions: true elides --no-extensions but keeps every other flag (burrow-12ba)", () => {
		const argv = buildPiArgv(undefined, { extensions: true });
		expect(argv).toEqual([...PI_FORCED_ARGV_WITH_EXTENSIONS, "--model", PI_DEFAULT_MODEL]);
		expect(argv).not.toContain("--no-extensions");
		for (const flag of PI_FORCED_ARGV) {
			if (flag === "--no-extensions") continue;
			expect(argv).toContain(flag);
		}
	});

	test("extensions: true composes with provider + model frontmatter overrides", () => {
		const argv = buildPiArgv({ provider: "openai", model: "gpt-4o" }, { extensions: true });
		expect(argv).not.toContain("--no-extensions");
		const providerIdx = argv.indexOf("--provider");
		expect(argv[providerIdx + 1]).toBe("openai");
		const modelIdx = argv.indexOf("--model");
		expect(argv[modelIdx + 1]).toBe("gpt-4o");
	});

	test("frontmatter.pi.extensions elides --no-extensions for batch pi", () => {
		const argv = buildPiArgv({ pi: { extensions: true } });
		expect(argv).toEqual([...PI_FORCED_ARGV_WITH_EXTENSIONS, "--model", PI_DEFAULT_MODEL]);
		expect(argv).not.toContain("--no-extensions");
	});

	test("frontmatter.pi.approve trusts project resources without changing provider/model", () => {
		const argv = buildPiArgv({ pi: { approve: true } });
		expect(argv).toEqual([
			"pi",
			"--mode",
			"rpc",
			"--session-dir",
			PI_SESSION_DIR,
			"--no-extensions",
			"--offline",
			"--approve",
			"--provider",
			PI_DEFAULT_PROVIDER,
			"--model",
			PI_DEFAULT_MODEL,
		]);
	});

	test("frontmatter.pi options compose allowlisted flags in stable order", () => {
		const argv = buildPiArgv({
			provider: "openai",
			model: "gpt-4o",
			pi: {
				extensions: true,
				approve: true,
				noBuiltinTools: true,
				tools: ["read", "my_extension_tool"],
				excludeTools: "bash,write",
				extension: [".pi/extensions/a.ts", " .pi/extensions/b.ts "],
				skill: ".pi/skills/review/SKILL.md",
				promptTemplate: [".pi/prompts/summary.md"],
				theme: [" ", ".pi/themes/dark.json"],
			},
		});
		expect(argv).toEqual([
			"pi",
			"--mode",
			"rpc",
			"--session-dir",
			PI_SESSION_DIR,
			"--offline",
			"--approve",
			"--no-builtin-tools",
			"--tools",
			"read,my_extension_tool",
			"--exclude-tools",
			"bash,write",
			"--extension",
			".pi/extensions/a.ts",
			"--extension",
			".pi/extensions/b.ts",
			"--skill",
			".pi/skills/review/SKILL.md",
			"--prompt-template",
			".pi/prompts/summary.md",
			"--theme",
			".pi/themes/dark.json",
			"--provider",
			"openai",
			"--model",
			"gpt-4o",
		]);
	});

	test("frontmatter.pi ignores unknown and wrong-shaped option values", () => {
		const argv = buildPiArgv({
			pi: {
				extensions: false,
				approve: "yes" as unknown as boolean,
				tools: ["read", 7] as unknown as string[],
				extension: "   ",
			},
		});
		expect(argv).toEqual([
			"pi",
			"--mode",
			"rpc",
			"--session-dir",
			PI_SESSION_DIR,
			"--no-extensions",
			"--offline",
			"--tools",
			"read",
			"--provider",
			PI_DEFAULT_PROVIDER,
			"--model",
			PI_DEFAULT_MODEL,
		]);
	});

	test("extensions: false is byte-identical to the no-options call (default keeps --no-extensions)", () => {
		expect(buildPiArgv(undefined, { extensions: false })).toEqual(buildPiArgv());
		expect(buildPiArgv({ provider: "openai" }, { extensions: false })).toEqual(
			buildPiArgv({ provider: "openai" }),
		);
	});

	test("PI_FORCED_ARGV stays bit-for-bit identical (the constant is the no-override default)", () => {
		// Constant must not be mutated across buildPiArgv calls — guards
		// against an accidental in-place [PI_FORCED_ARGV.length-1] = ...
		// (the helper uses a copy, but pin the invariant explicitly).
		buildPiArgv({ provider: "openai", model: "gpt-4o" });
		buildPiArgv({ provider: "openai" }, { extensions: true });
		expect([...PI_FORCED_ARGV]).toEqual([
			"pi",
			"--mode",
			"rpc",
			"--session-dir",
			PI_SESSION_DIR,
			"--no-extensions",
			"--offline",
			"--provider",
			PI_DEFAULT_PROVIDER,
		]);
	});
});

describe("encodePiStdin", () => {
	test("omits the prompt line when the prompt is empty (steering-only nudge)", () => {
		const blob = encodePiStdin("", [fakeMessage()]);
		expect(blob.endsWith("\n")).toBe(true);
		const lines = blob.split("\n").slice(0, -1);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] ?? "") as { type: string; message: string };
		expect(parsed.type).toBe("prompt");
		expect(parsed.message).toContain("[STEERING]");
	});

	test("returns an empty string when both prompt and messages are empty", () => {
		expect(encodePiStdin("", [])).toBe("");
	});

	test("emits one RPC line per pending steering message in order", () => {
		const blob = encodePiStdin("", [
			fakeMessage({ body: "first", priority: "urgent" }),
			fakeMessage({ body: "second", priority: "low" }),
		]);
		expect(blob.endsWith("\n")).toBe(true);
		const lines = blob.split("\n").slice(0, -1);
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l) as { type: string; message: string });
		expect(parsed[0]?.type).toBe("prompt");
		expect(parsed[0]?.message).toContain("priority: urgent");
		expect(parsed[0]?.message).toContain("first");
		expect(parsed[1]?.message).toContain("priority: low");
		expect(parsed[1]?.message).toContain("second");
	});

	test("single-prompt case terminates with a newline (burrow-faf5)", () => {
		// pi's RPC mode is line-delimited — without a trailing \n it sits on
		// an incomplete JSON line and never processes the prompt.
		const blob = encodePiStdin("hello", []);
		expect(blob.endsWith("\n")).toBe(true);
		const lines = blob.split("\n").slice(0, -1);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] ?? "") as { type: string; message: string };
		expect(parsed.type).toBe("prompt");
		expect(parsed.message).toBe("hello");
	});

	test("prompt + steering messages all terminate with newlines", () => {
		const blob = encodePiStdin("primary", [fakeMessage({ body: "first", priority: "urgent" })]);
		expect(blob.endsWith("\n")).toBe(true);
		const lines = blob.split("\n").slice(0, -1);
		expect(lines).toHaveLength(2);
	});
});
