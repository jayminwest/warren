import { describe, expect, test } from "bun:test";
import {
	ENV_AGENT_RUN_AS_GID,
	ENV_AGENT_RUN_AS_UID,
	parseAgentUidDrop,
	SETPRIV_BIN,
	uidDropPreflightArgv,
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
