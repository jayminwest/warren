import { describe, expect, test } from "bun:test";
import { AgentSchemaError } from "./errors.ts";
import { parseRenderedAgent } from "./schema.ts";
import { readSteeringCapability } from "./steering.ts";

const VALID = {
	success: true,
	command: "render",
	name: "refactor-bot",
	version: 3,
	sections: [{ name: "system", body: "You are a refactor agent." }],
};
describe("readSteeringCapability", () => {
	test("returns undefined when the agent declares no steering capability (legacy fail-open)", () => {
		expect(readSteeringCapability({})).toBeUndefined();
		expect(readSteeringCapability({ runtime: "pi" })).toBeUndefined();
	});

	test("accepts each STEERING_CAPABILITIES member", () => {
		expect(readSteeringCapability({ steering: "mid-run" })).toBe("mid-run");
		expect(readSteeringCapability({ steering: "spawn-only" })).toBe("spawn-only");
		expect(readSteeringCapability({ steering: "none" })).toBe("none");
	});

	test("rejects an out-of-vocabulary value with AgentSchemaError", () => {
		expect(() => readSteeringCapability({ steering: "sometimes" }, "bot")).toThrow(
			AgentSchemaError,
		);
		expect(() => readSteeringCapability({ steering: 42 }, "bot")).toThrow(
			/frontmatter\.steering must be one of/,
		);
	});

	test("validateAgentDefinition rejects a malformed steering declaration at registration", () => {
		expect(() => parseRenderedAgent({ ...VALID, frontmatter: { steering: "midturn" } })).toThrow(
			AgentSchemaError,
		);
	});
});
