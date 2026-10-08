import { describe, expect, test } from "bun:test";
import { WarrenError } from "../../core/errors.ts";
import { reapStepError } from "./step-error.ts";

class LegacyError extends WarrenError {
	readonly code = "legacy_worktree_workspace";
}

describe("reapStepError", () => {
	test("keeps a WarrenError's code and recovery hint", () => {
		const err = new LegacyError("shared-clone worktree", { recoveryHint: "push it by hand" });
		expect(reapStepError("workspace_lookup", err)).toEqual({
			step: "workspace_lookup",
			message: "shared-clone worktree",
			code: "legacy_worktree_workspace",
			recoveryHint: "push it by hand",
		});
	});

	test("records only the message for a plain error, plus the path when given", () => {
		expect(reapStepError("finalize", new Error("boom"), "/ws")).toEqual({
			step: "finalize",
			message: "boom",
			path: "/ws",
		});
		expect(reapStepError("finalize", "text")).toEqual({ step: "finalize", message: "text" });
	});
});
