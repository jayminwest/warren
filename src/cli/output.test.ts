import { describe, expect, test } from "bun:test";
import { WarrenClientError, WarrenUnreachableError } from "../client/errors.ts";
import { ValidationError } from "../core/errors.ts";
import {
	type CliContext,
	commandFailure,
	defaultSpawn,
	EXIT_AUTH_REJECTED,
	EXIT_CODE_TABLE,
	EXIT_RUN_FAILED,
	EXIT_SERVER_UNREACHABLE,
	EXIT_USAGE,
	exitCodeForError,
	formatDurationMs,
	formatError,
	formatExitCodeTable,
	OUTPUT_MODES,
	type OutputMode,
	outputMode,
	PROCESS_STDIO,
	parseOutputMode,
	writeJsonLine,
	writeResult,
} from "./output.ts";

describe("writeJsonLine", () => {
	test("writes a single newline-terminated JSON object", () => {
		const chunks: string[] = [];
		writeJsonLine({ write: (c) => chunks.push(c) }, { ok: true, n: 2 });
		expect(chunks).toEqual([`${JSON.stringify({ ok: true, n: 2 })}\n`]);
	});
});

describe("formatError", () => {
	test("formats a WarrenError with code and recovery hint", () => {
		const err = new ValidationError("boom", { recoveryHint: "set FOO=1" });
		expect(formatError(err)).toBe("[validation_error] boom\n  hint: set FOO=1");
	});

	test("formats a plain Error without code or hint", () => {
		expect(formatError(new Error("oops"))).toBe("oops");
	});

	test("stringifies a non-Error", () => {
		expect(formatError(42)).toBe("42");
	});
});

describe("PROCESS_STDIO", () => {
	test("stdout.write delegates to process.stdout.write", () => {
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string) => {
			chunks.push(chunk);
			return true;
		};
		try {
			PROCESS_STDIO.stdout.write("hello stdout\n");
		} finally {
			process.stdout.write = original;
		}
		expect(chunks).toContain("hello stdout\n");
	});

	test("stderr.write delegates to process.stderr.write", () => {
		const chunks: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk: string) => {
			chunks.push(chunk);
			return true;
		};
		try {
			PROCESS_STDIO.stderr.write("hello stderr\n");
		} finally {
			process.stderr.write = original;
		}
		expect(chunks).toContain("hello stderr\n");
	});
});

describe("defaultSpawn", () => {
	test("runs a command and captures stdout/stderr", async () => {
		const result = await defaultSpawn(["echo", "coverage-test"], { cwd: "/tmp" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("coverage-test");
		expect(result.stderr).toBe("");
	});
});

describe("parseOutputMode", () => {
	test("defaults an unset flag to ndjson", () => {
		expect(parseOutputMode(undefined)).toBe("ndjson");
	});

	test("accepts each documented mode", () => {
		for (const mode of OUTPUT_MODES) {
			expect(parseOutputMode(mode)).toBe(mode);
		}
	});

	test("rejects an unrecognised mode as null", () => {
		expect(parseOutputMode("yaml")).toBeNull();
	});
});

describe("outputMode", () => {
	test("falls back to ndjson when the context carries no mode", () => {
		const context = { env: {}, stdio: { stdout: sink(), stderr: sink() }, spawn: defaultSpawn };
		expect(outputMode(context)).toBe("ndjson");
	});
});

describe("writeResult", () => {
	test("ndjson emits one compact line", () => {
		const out = sink();
		writeResult(contextWith("ndjson", out), { ok: true });
		expect(out.chunks).toEqual([`{"ok":true}\n`]);
	});

	test("json emits a single indented document", () => {
		const out = sink();
		writeResult(contextWith("json", out), { ok: true });
		expect(out.chunks).toEqual([`${JSON.stringify({ ok: true }, null, 2)}\n`]);
	});

	test("pretty emits the human line when provided", () => {
		const out = sink();
		writeResult(contextWith("pretty", out), { ok: true }, "✔ done");
		expect(out.chunks).toEqual(["✔ done\n"]);
	});

	test("pretty falls back to the indented document without a human line", () => {
		const out = sink();
		writeResult(contextWith("pretty", out), { ok: true });
		expect(out.chunks).toEqual([`${JSON.stringify({ ok: true }, null, 2)}\n`]);
	});
});

describe("exit-code contract", () => {
	test("the table pins the stable codes", () => {
		expect(EXIT_CODE_TABLE.map((row) => [row.code, row.name])).toEqual([
			[0, "success"],
			[1, "run-failed"],
			[2, "usage-error"],
			[3, "server-unreachable"],
			[4, "auth-rejected"],
			[130, "sigint-detach"],
		]);
	});

	test("formatExitCodeTable renders one line per row", () => {
		const table = formatExitCodeTable();
		expect(table.split("\n")).toHaveLength(EXIT_CODE_TABLE.length);
		expect(table).toContain("server-unreachable");
	});

	test("exitCodeForError maps the error hierarchy onto the table", () => {
		expect(exitCodeForError(new WarrenUnreachableError("down"))).toBe(EXIT_SERVER_UNREACHABLE);
		expect(exitCodeForError(new WarrenClientError(401, "unauthorized", "bad token"))).toBe(
			EXIT_AUTH_REJECTED,
		);
		expect(exitCodeForError(new WarrenClientError(403, "forbidden", "nope"))).toBe(
			EXIT_AUTH_REJECTED,
		);
		expect(exitCodeForError(new ValidationError("bad input"))).toBe(EXIT_USAGE);
		expect(exitCodeForError(new WarrenClientError(400, "validation_error", "bad"))).toBe(
			EXIT_RUN_FAILED,
		);
		expect(exitCodeForError(new Error("misc"))).toBe(EXIT_RUN_FAILED);
	});

	test("commandFailure routes errors through exitCodeForError", () => {
		const errSink = sink();
		const context = {
			env: {},
			stdio: { stdout: sink(), stderr: errSink },
			spawn: defaultSpawn,
		};
		expect(commandFailure(context, new WarrenUnreachableError("down")).exitCode).toBe(3);
		expect(commandFailure(context, new ValidationError("bad")).exitCode).toBe(2);
		expect(errSink.chunks.join("")).toContain("down");
	});

	test("commandFailure names the env token source on an auth rejection (warren-8807)", () => {
		const errSink = sink();
		const context = {
			env: { WARREN_API_TOKEN: "tok-stale" },
			stdio: { stdout: sink(), stderr: errSink },
			spawn: defaultSpawn,
			tokenSource: "env" as const,
		};
		const { exitCode } = commandFailure(context, new WarrenClientError(401, "unauthorized", "no"));
		expect(exitCode).toBe(4);
		const text = errSink.chunks.join("");
		expect(text).toContain("token came from WARREN_API_TOKEN in the environment");
		expect(text).toContain(".env`");
		expect(text).not.toContain("tok-stale");
	});

	test("commandFailure blames --token, not an unrelated env token (warren-2d4c)", () => {
		const errSink = sink();
		const context = {
			env: { WARREN_API_TOKEN: "tok-env" },
			stdio: { stdout: sink(), stderr: errSink },
			spawn: defaultSpawn,
			tokenSource: "flag" as const,
		};
		commandFailure(context, new WarrenClientError(401, "unauthorized", "no"));
		const text = errSink.chunks.join("");
		expect(text).toContain("token came from --token");
		expect(text).not.toContain("WARREN_API_TOKEN in the environment");
	});

	test("commandFailure names the config file a rejected token came from (warren-2d4c)", () => {
		const errSink = sink();
		const context = {
			env: { WARREN_CLIENT_CONFIG: "/srv/agent/client.json" },
			stdio: { stdout: sink(), stderr: errSink },
			spawn: defaultSpawn,
			tokenSource: "config-file" as const,
		};
		commandFailure(context, new WarrenClientError(401, "unauthorized", "no"));
		const text = errSink.chunks.join("");
		expect(text).toContain("token came from the client config file");
		expect(text).toContain("/srv/agent/client.json");
	});

	test("commandFailure falls back to every slot when no source was resolved (warren-2d4c)", () => {
		const errSink = sink();
		const context = {
			env: { WARREN_CLIENT_CONFIG: "/srv/agent/client.json" },
			stdio: { stdout: sink(), stderr: errSink },
			spawn: defaultSpawn,
		};
		commandFailure(context, new WarrenClientError(401, "unauthorized", "no"));
		const text = errSink.chunks.join("");
		expect(text).toContain("WARREN_API_TOKEN");
		expect(text).toContain("warren login");
	});

	test("commandFailure stays silent about the token on a non-auth failure", () => {
		const errSink = sink();
		const context = {
			env: {},
			stdio: { stdout: sink(), stderr: errSink },
			spawn: defaultSpawn,
			tokenSource: "env" as const,
		};
		commandFailure(context, new WarrenUnreachableError("down"));
		expect(errSink.chunks.join("")).not.toContain("token came from");
	});
});

describe("formatDurationMs (D6)", () => {
	test("renders sub-minute durations as seconds", () => {
		expect(formatDurationMs(4200)).toBe("4.2s");
	});

	test("renders sub-hour durations as minutes", () => {
		expect(formatDurationMs(186_000)).toBe("3.1m");
	});

	test("renders longer durations as hours", () => {
		expect(formatDurationMs(5_040_000)).toBe("1.4h");
	});

	test("honours the unit boundaries", () => {
		expect(formatDurationMs(59_999)).toBe("60.0s");
		expect(formatDurationMs(60_000)).toBe("1.0m");
		expect(formatDurationMs(3_600_000)).toBe("1.0h");
	});
});

function sink(): { write: (chunk: string) => void; chunks: string[] } {
	const chunks: string[] = [];
	return {
		chunks,
		write: (chunk) => {
			chunks.push(chunk);
		},
	};
}

function contextWith(output: OutputMode, stdout: { write: (chunk: string) => void }): CliContext {
	return { env: {}, stdio: { stdout, stderr: sink() }, spawn: defaultSpawn, output };
}
