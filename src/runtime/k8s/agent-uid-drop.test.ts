import { describe, expect, test } from "bun:test";
import {
	crossUidKillArgv,
	ENV_AGENT_RUN_AS_GID,
	ENV_AGENT_RUN_AS_UID,
	parseAgentUidDrop,
	SETPRIV_BIN,
	UID_DROP_PREFLIGHT_ERROR_PREFIX,
	uidDropPreflightArgv,
	uidDropPreflightErrorMessage,
	withCrossUidKill,
	wrapArgvForUidDrop,
} from "./agent-uid-drop.ts";

describe("parseAgentUidDrop", () => {
	test("returns undefined when the env knob is absent or blank", () => {
		expect(parseAgentUidDrop({})).toBeUndefined();
		expect(parseAgentUidDrop({ [ENV_AGENT_RUN_AS_UID]: "   " })).toBeUndefined();
	});

	test("parses uid + gid and defaults the gid to the uid", () => {
		expect(
			parseAgentUidDrop({ [ENV_AGENT_RUN_AS_UID]: "1001", [ENV_AGENT_RUN_AS_GID]: "1000" }),
		).toEqual({
			uid: 1001,
			gid: 1000,
		});
		expect(parseAgentUidDrop({ [ENV_AGENT_RUN_AS_UID]: "1001" })).toEqual({ uid: 1001, gid: 1001 });
	});

	test("throws (fails closed) on malformed, zero, or negative ids", () => {
		for (const bad of ["abc", "1.5", "0", "-1", ""]) {
			// blank uid is "absent"; the rest must throw
			if (bad === "") continue;
			expect(() => parseAgentUidDrop({ [ENV_AGENT_RUN_AS_UID]: bad })).toThrow(
				ENV_AGENT_RUN_AS_UID,
			);
		}
		expect(() =>
			parseAgentUidDrop({ [ENV_AGENT_RUN_AS_UID]: "1001", [ENV_AGENT_RUN_AS_GID]: "0" }),
		).toThrow(ENV_AGENT_RUN_AS_GID);
	});
});

describe("wrapArgvForUidDrop", () => {
	test("prefixes the agent argv with the full setpriv lockdown", () => {
		const wrapped = wrapArgvForUidDrop(["claude", "--print"], { uid: 1001, gid: 1000 });
		expect(wrapped).toEqual([
			SETPRIV_BIN,
			"--reuid=1001",
			"--regid=1000",
			"--clear-groups",
			"--no-new-privs",
			"--inh-caps=-all",
			"--ambient-caps=-all",
			"--bounding-set=-all",
			"--",
			"claude",
			"--print",
		]);
	});

	test("the preflight probe shares the drop flags and execs `true`", () => {
		const probe = uidDropPreflightArgv({ uid: 1001, gid: 1000 });
		expect(probe.slice(0, -2)).toEqual(
			wrapArgvForUidDrop([], { uid: 1001, gid: 1000 }).slice(0, -1),
		);
		expect(probe.at(-1)).toBe("true");
	});
});

describe("uidDropPreflightErrorMessage", () => {
	test("starts with the stable prefix reap's classifier keys on (warren-950d)", () => {
		expect(uidDropPreflightErrorMessage(127).startsWith(UID_DROP_PREFLIGHT_ERROR_PREFIX)).toBe(
			true,
		);
		expect(uidDropPreflightErrorMessage(127)).toContain("setpriv exited 127");
	});
});

describe("crossUidKillArgv (warren-950d)", () => {
	test("assumes the agent's uid via the shared drop flags, then signals via the sh builtin", () => {
		const argv = crossUidKillArgv({ uid: 1001, gid: 1000 }, 42);
		expect(argv.slice(0, -3)).toEqual(wrapArgvForUidDrop([], { uid: 1001, gid: 1000 }));
		expect(argv.slice(-3)).toEqual(["sh", "-c", "kill -KILL 42"]);
	});

	test("refuses a non-positive or non-integer pid", () => {
		expect(() => crossUidKillArgv({ uid: 1001, gid: 1000 }, 0)).toThrow("positive pid");
		expect(() => crossUidKillArgv({ uid: 1001, gid: 1000 }, 1.5)).toThrow("positive pid");
	});
});

describe("withCrossUidKill (warren-950d)", () => {
	const drop = { uid: 1001, gid: 1000 };

	test("routes kill through the setpriv cross-uid helper", async () => {
		const spawned: string[][] = [];
		let directKills = 0;
		const proc = withCrossUidKill({ pid: 42, kill: () => directKills++ }, drop, {
			spawn: (command) => {
				spawned.push([...command.argv]);
				return { exited: Promise.resolve(0) };
			},
			cwd: "/workspace",
			log: () => {},
		});
		proc.kill?.();
		await Bun.sleep(0);
		expect(spawned).toEqual([crossUidKillArgv(drop, 42)]);
		expect(directKills).toBe(0);
	});

	test("falls back to the direct kill when the setpriv kill fails", async () => {
		let directKills = 0;
		const logs: string[] = [];
		const proc = withCrossUidKill({ pid: 42, kill: () => directKills++ }, drop, {
			spawn: () => ({ exited: Promise.resolve(127) }),
			cwd: "/workspace",
			log: (m) => logs.push(m),
		});
		proc.kill?.();
		await Bun.sleep(0);
		expect(directKills).toBe(1);
		expect(logs.some((m) => m.includes("cross-uid kill failed"))).toBe(true);
	});

	test("leaves the proc untouched when the pid is unknown", () => {
		const original = { kill: () => {} };
		expect(
			withCrossUidKill(original, drop, {
				spawn: () => ({ exited: Promise.resolve(0) }),
				cwd: "/w",
				log: () => {},
			}),
		).toBe(original);
	});
});
