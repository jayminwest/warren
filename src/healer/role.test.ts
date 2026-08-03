import { describe, expect, test } from "bun:test";
import { checkHealerRole } from "./role.ts";

describe("checkHealerRole", () => {
	test("accepts a role that names a registered agent", () => {
		const result = checkHealerRole({
			role: "healer",
			projectId: "prj_1",
			knownRoles: ["claude-code", "healer"],
		});
		expect(result).toEqual({ kind: "ok" });
	});

	test("rejects an unknown role with a config-shaped message", () => {
		const result = checkHealerRole({
			role: "healr",
			projectId: "prj_1",
			knownRoles: ["healer", "claude-code"],
		});
		expect(result.kind).toBe("unknown_role");
		if (result.kind !== "unknown_role") return;
		expect(result.message).toContain('healer.role "healr"');
		expect(result.message).toContain("prj_1");
		expect(result.message).toContain(".warren/config.yaml");
		expect(result.message).toContain("claude-code, healer");
	});

	test("names the empty registry explicitly", () => {
		const result = checkHealerRole({ role: "healer", projectId: "prj_1", knownRoles: [] });
		expect(result.kind).toBe("unknown_role");
		if (result.kind !== "unknown_role") return;
		expect(result.message).toContain("(no agents registered)");
	});

	test("truncates a long agent list", () => {
		const knownRoles = Array.from({ length: 20 }, (_, i) => `agent-${String(i).padStart(2, "0")}`);
		const result = checkHealerRole({ role: "nope", projectId: "prj_1", knownRoles });
		expect(result.kind).toBe("unknown_role");
		if (result.kind !== "unknown_role") return;
		expect(result.message).toContain("…");
		expect(result.message).not.toContain("agent-19");
	});

	test("matches exactly, not case-insensitively", () => {
		expect(checkHealerRole({ role: "Healer", projectId: "p", knownRoles: ["healer"] }).kind).toBe(
			"unknown_role",
		);
	});
});
