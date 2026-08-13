/**
 * Agent-exit-code hint on the finalize-intent poll (warren-5202). The pod
 * overlays `WARREN_AGENT_EXIT_CODE` (agent-entrypoint) and reports it as
 * `?agent_exit=` on every `GET /runs/:id/finalize-intent` poll, so a
 * control plane recovering from a mid-run replacement can classify the run's
 * outcome from the pod's own witness instead of the (possibly log-rotated)
 * terminal envelope. Split out of `finalize-entrypoint.test.ts` (file-size
 * ratchet).
 */

import { describe, expect, test } from "bun:test";
import {
	type FinalizeHttp,
	parseFinalizeEntrypointEnv,
	pollForIntent,
} from "./finalize-entrypoint.ts";
import { IN_POD_FINALIZE_WIRE_VERSION, type InPodFinalizeIntent } from "./finalize-wire.ts";

const env = {
	WARREN_RUN_ID: "run_x",
	WARREN_API_URL: "http://warren:8080",
	WARREN_API_TOKEN: "tok",
	WARREN_WORKSPACE_PATH: "/ws",
};

function intent(): InPodFinalizeIntent {
	return {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		attemptId: "fin_abcdefghjkmn",
		branch: "warren/run_x",
		push: true,
		artifacts: ["seeds"],
		commit: ["seeds"],
	};
}

function recordingHttp(urls: string[]): FinalizeHttp {
	return {
		get: async (url) => {
			urls.push(url);
			return { status: 200, body: { intent: intent() } };
		},
		post: async () => ({ status: 200 }),
	};
}

describe("finalize-intent poll agent_exit hint (warren-5202)", () => {
	test("polls carry the agent exit code as ?agent_exit= when the overlay is set", async () => {
		const urls: string[] = [];
		const parsed = parseFinalizeEntrypointEnv({ ...env, WARREN_AGENT_EXIT_CODE: "0" });
		expect(parsed.agentExitCode).toBe(0);
		const found = await pollForIntent(
			parsed,
			recordingHttp(urls),
			async () => {},
			() => 0,
			() => {},
		);
		expect(found).not.toBeNull();
		expect(urls[0]).toBe("http://warren:8080/runs/run_x/finalize-intent?agent_exit=0");
	});

	test("a non-zero exit code rides the poll verbatim (the control plane classifies failed)", async () => {
		const urls: string[] = [];
		const parsed = parseFinalizeEntrypointEnv({ ...env, WARREN_AGENT_EXIT_CODE: "1" });
		expect(parsed.agentExitCode).toBe(1);
		await pollForIntent(
			parsed,
			recordingHttp(urls),
			async () => {},
			() => 0,
			() => {},
		);
		expect(urls[0]).toBe("http://warren:8080/runs/run_x/finalize-intent?agent_exit=1");
	});

	test("polls omit ?agent_exit= when the overlay is absent or malformed (pre-hint pods)", async () => {
		const urls: string[] = [];
		const http = recordingHttp(urls);
		const absent = parseFinalizeEntrypointEnv(env);
		expect(absent.agentExitCode).toBeUndefined();
		await pollForIntent(
			absent,
			http,
			async () => {},
			() => 0,
			() => {},
		);
		const malformed = parseFinalizeEntrypointEnv({ ...env, WARREN_AGENT_EXIT_CODE: "bogus" });
		expect(malformed.agentExitCode).toBeUndefined();
		await pollForIntent(
			malformed,
			http,
			async () => {},
			() => 0,
			() => {},
		);
		expect(urls).toEqual([
			"http://warren:8080/runs/run_x/finalize-intent",
			"http://warren:8080/runs/run_x/finalize-intent",
		]);
	});
});
