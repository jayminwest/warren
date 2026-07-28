import { describe, expect, test } from "bun:test";
import { WarrenError } from "../core/errors.ts";
import { AgentSchemaError } from "./errors.ts";

describe("AgentSchemaError", () => {
	test("is a WarrenError with the agent_schema_error code", () => {
		const err = new AgentSchemaError("missing system section");
		expect(err).toBeInstanceOf(WarrenError);
		expect(err.code).toBe("agent_schema_error");
		expect(err.name).toBe("AgentSchemaError");
		expect(err.message).toBe("missing system section");
	});
});
