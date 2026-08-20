import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import type { FinalizeResult } from "../contract.ts";
import {
	IN_POD_FINALIZE_WIRE_VERSION,
	parseFinalizeResultEnvelope,
	parseSalvageEnvelope,
	validateFinalizeResult,
} from "./finalize-wire.ts";

function fullResult(): FinalizeResult {
	return {
		pushed: true,
		commitsAhead: 3,
		emptyPush: false,
		dirty: false,
		workspacePlansBody: '{"id":"pl-1"}\n',
		events: [{ kind: "seeds.closed", payload: { id: "warren-1" } }],
		artifacts: {
			mulch: {
				version: 1,
				files: [{ path: ".mulch/expertise/build.jsonl", mergedBody: "x\ny\n" }],
				counts: { updated: 0, skipped: 0, appended: 2 },
			},
			seeds: {
				version: 1,
				files: [{ path: ".seeds/issues.jsonl", mergedBody: "z\n" }],
				counts: { closed: 1, created: 0 },
			},
			plans: {
				version: 1,
				files: [{ path: ".seeds/plans.jsonl", mergedBody: "p\n" }],
				counts: { appended: 1 },
			},
		},
		prBranch: "warren/run_x",
		stages: [
			{ stage: "mulch_merge", status: "ok" },
			{ stage: "branch_push", status: "failed", error: "auth" },
		],
	};
}

describe("validateFinalizeResult", () => {
	test("round-trips a full contract-shaped result through JSON unchanged", () => {
		const r = fullResult();
		expect(validateFinalizeResult(JSON.parse(JSON.stringify(r)))).toEqual(r);
	});

	test("carries an optional commitsAheadBase and keeps it off the shape when absent (warren-ba08)", () => {
		expect(validateFinalizeResult(fullResult())).not.toHaveProperty("commitsAheadBase");
		const withBase = { ...fullResult(), commitsAheadBase: "0123abcd" };
		expect(validateFinalizeResult(withBase).commitsAheadBase).toBe("0123abcd");
		expect(() =>
			validateFinalizeResult({ ...fullResult(), commitsAheadBase: 7 } as unknown),
		).toThrow(ValidationError);
	});

	test("accepts commitsAhead: null (the widened shape)", () => {
		const r = { ...fullResult(), commitsAhead: null };
		expect(validateFinalizeResult(r).commitsAhead).toBeNull();
	});

	test("rejects a non-boolean pushed", () => {
		expect(() => validateFinalizeResult({ ...fullResult(), pushed: "yes" })).toThrow(
			ValidationError,
		);
	});

	test("rejects an unknown stage name", () => {
		const bad = { ...fullResult(), stages: [{ stage: "not_a_stage", status: "ok" }] };
		expect(() => validateFinalizeResult(bad)).toThrow(/not a known finalize stage/);
	});

	test("accepts an empty mergedBody — a pruned tracker file is legal workspace truth (warren-8e05)", () => {
		const r = fullResult();
		const artifacts = {
			...r.artifacts,
			mulch: {
				...r.artifacts.mulch,
				files: [{ path: ".mulch/expertise/sandbox.jsonl", mergedBody: "" }],
				counts: { updated: 0, skipped: 0, appended: 0 },
			},
		};
		const out = validateFinalizeResult({ ...r, artifacts });
		expect(out.artifacts.mulch?.files[0]?.mergedBody).toBe("");
	});

	test("still rejects an empty path on a delta file entry", () => {
		const r = fullResult();
		const artifacts = {
			...r.artifacts,
			mulch: { ...r.artifacts.mulch, files: [{ path: "", mergedBody: "x\n" }] },
		};
		expect(() => validateFinalizeResult({ ...r, artifacts })).toThrow(/path must be a non-empty/);
	});

	test("rejects a malformed artifact delta file entry", () => {
		const bad = fullResult();
		const badArtifacts = {
			...bad.artifacts,
			mulch: { ...bad.artifacts.mulch, files: [{ mergedBody: "x" }] },
		};
		expect(() => validateFinalizeResult({ ...bad, artifacts: badArtifacts })).toThrow(
			ValidationError,
		);
	});
});

describe("parseFinalizeResultEnvelope", () => {
	test("parses a well-formed envelope", () => {
		const env = parseFinalizeResultEnvelope({
			version: IN_POD_FINALIZE_WIRE_VERSION,
			attemptId: "fin_abcdefghjkmn",
			result: fullResult(),
		});
		expect(env.attemptId).toBe("fin_abcdefghjkmn");
		expect(env.result.pushed).toBe(true);
	});

	test("rejects a mismatched wire version", () => {
		expect(() =>
			parseFinalizeResultEnvelope({ version: 2, attemptId: "fin_x", result: fullResult() }),
		).toThrow(/wire version/);
	});

	test("rejects a missing attemptId", () => {
		expect(() =>
			parseFinalizeResultEnvelope({ version: IN_POD_FINALIZE_WIRE_VERSION, result: fullResult() }),
		).toThrow(ValidationError);
	});
});

describe("parseSalvageEnvelope (warren-cd3b)", () => {
	function fullSalvage(): Record<string, unknown> {
		return {
			version: IN_POD_FINALIZE_WIRE_VERSION,
			trigger: "push_failed",
			rescueRef: "warren/rescue/run_x",
			bundleBase64: "YnVuZGxl",
			branch: "warren/run_x",
			baseBranch: "main",
			notes: ["rescue push failed: declined"],
		};
	}

	test("parses a well-formed envelope", () => {
		const env = parseSalvageEnvelope(fullSalvage());
		expect(env.trigger).toBe("push_failed");
		expect(env.rescueRef).toBe("warren/rescue/run_x");
		expect(env.bundleBase64).toBe("YnVuZGxl");
		expect(env.notes).toEqual(["rescue push failed: declined"]);
	});

	test("null capture fields parse (nothing recovered, notes-only envelope)", () => {
		const env = parseSalvageEnvelope({
			...fullSalvage(),
			trigger: "no_intent",
			rescueRef: null,
			bundleBase64: null,
		});
		expect(env.trigger).toBe("no_intent");
		expect(env.rescueRef).toBeNull();
		expect(env.bundleBase64).toBeNull();
	});

	test("rejects a mismatched wire version", () => {
		expect(() => parseSalvageEnvelope({ ...fullSalvage(), version: 2 })).toThrow(/wire version/);
	});

	test("rejects an unknown trigger", () => {
		expect(() => parseSalvageEnvelope({ ...fullSalvage(), trigger: "oops" })).toThrow(/trigger/);
	});

	test("rejects a non-string bundle", () => {
		expect(() => parseSalvageEnvelope({ ...fullSalvage(), bundleBase64: 42 })).toThrow(
			ValidationError,
		);
	});
});
