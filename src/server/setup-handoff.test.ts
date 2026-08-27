import { describe, expect, test } from "bun:test";
import { armSetupHandoff, type SetupHandoffLogger } from "./setup-handoff.ts";

const logger: SetupHandoffLogger = {
	warn() {},
	info() {},
};

function warns(): { logger: SetupHandoffLogger; lines: string[] } {
	const lines: string[] = [];
	return {
		lines,
		logger: {
			warn: (_obj, msg) => lines.push(msg),
			info: () => undefined,
		},
	};
}

describe("armSetupHandoff", () => {
	test("mints a single-use code bound to the operator token when wanted and armed-able", () => {
		const armed = armSetupHandoff({
			wanted: true,
			noAuth: false,
			authKind: "token",
			token: "tok",
			logger,
			random: () => "code-1",
		});
		expect(armed).toBeDefined();
		expect(armed?.code).toBe("code-1");
		expect(armed?.store.redeem("code-1")).toBe("tok");
		expect(armed?.store.redeem("code-1")).toBeNull();
	});

	test("refuses to arm under WARREN_AUTH=public and says why", () => {
		const { logger: log, lines } = warns();
		const armed = armSetupHandoff({
			wanted: true,
			noAuth: false,
			authKind: "public",
			token: "tok",
			logger: log,
		});
		expect(armed).toBeUndefined();
		expect(lines.join(" ")).toContain("WARREN_AUTH=public");
	});

	test("does not arm under --no-auth (no token to hand off)", () => {
		const armed = armSetupHandoff({
			wanted: true,
			noAuth: true,
			authKind: "token",
			token: undefined,
			logger,
		});
		expect(armed).toBeUndefined();
	});

	test("does not arm when the boot did not ask (plain warren serve)", () => {
		const armed = armSetupHandoff({
			wanted: false,
			noAuth: false,
			authKind: "token",
			token: "tok",
			logger,
		});
		expect(armed).toBeUndefined();
	});

	test("does not arm when no operator token resolved", () => {
		const armed = armSetupHandoff({
			wanted: true,
			noAuth: false,
			authKind: "token",
			token: undefined,
			logger,
		});
		expect(armed).toBeUndefined();
	});

	test("the minted code expires with the TTL", () => {
		let now = 1000;
		const armed = armSetupHandoff({
			wanted: true,
			noAuth: false,
			authKind: "token",
			token: "tok",
			logger,
			now: () => now,
			random: () => "code-1",
		});
		now = 1000 + 10 * 60 * 1000 + 1;
		expect(armed?.store.redeem("code-1")).toBeNull();
	});
});
