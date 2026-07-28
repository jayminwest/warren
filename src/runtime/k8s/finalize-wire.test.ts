import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import type { FinalizeResult } from "../contract.ts";
import {
	IN_POD_FINALIZE_WIRE_VERSION,
	parseFinalizeResultEnvelope,
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
