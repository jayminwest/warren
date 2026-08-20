import { describe, expect, test } from "bun:test";
import type { RunSpec } from "../contract.ts";
import {
	buildRunPod,
	ENV_AGENT_RUN_AS_GID,
	ENV_AGENT_RUN_AS_UID,
	resolveK8sPodConfig,
	WARREN_POD_AGENT_UID,
	WARREN_POD_GID,
} from "./pod-spec.ts";

/**
 * warren-cb93: the entrypoint/agent uid split at the pod-spec seam — the
 * agent container carries the caps the ENTRYPOINT's setpriv needs (never the
 * agent's) plus the `WARREN_AGENT_RUN_AS_*` env contract, and
 * `WARREN_K8S_AGENT_UID_DROP=0` restores the legacy shared-uid shape.
 */

function baseSpec(overrides: Partial<RunSpec> = {}): RunSpec {
	return {
		runId: "run_01tdf3a0wg5e",
		originUrl: "https://github.com/acme/widgets.git",
		branch: "warren/run_01tdf3a0wg5e",
		baseBranch: "main",
		runtimeId: "claude-code",
		prompt: "do the thing",
		mode: "batch",
		network: "restricted",
		seedFiles: [],
		env: { WARREN_API_TOKEN: "tok" },
		...overrides,
	};
}

describe("buildRunPod uid split (warren-cb93)", () => {
	test("the agent container adds SETUID/SETGID/KILL for the entrypoint's setpriv split", () => {
		const pod = buildRunPod(baseSpec(), resolveK8sPodConfig({}));
		const init = pod.spec?.initContainers?.[0];
		const agent = pod.spec?.containers?.[0];
		// The init container materializes the workspace and never spawns the
		// agent — it keeps the bare drop-ALL posture.
		expect(init?.securityContext?.capabilities).toEqual({ drop: ["ALL"] });
		// The agent container's ENTRYPOINT (uid 1000) needs SETUID/SETGID to
		// setpriv the agent process to WARREN_POD_AGENT_UID, and KILL so the
		// stdin-hold watchdog can still signal the split-off (cross-uid) agent.
		expect(agent?.securityContext?.capabilities).toEqual({
			drop: ["ALL"],
			add: ["SETUID", "SETGID", "KILL"],
		});
		expect(agent?.securityContext?.runAsNonRoot).toBe(true);
		expect(agent?.securityContext?.runAsUser).toBe(1000);
		expect(agent?.securityContext?.allowPrivilegeEscalation).toBe(false);
	});

	test("the agent env carries the uid-drop contract", () => {
		const pod = buildRunPod(baseSpec(), resolveK8sPodConfig({}));
		const env = pod.spec?.containers?.[0]?.env ?? [];
		expect(env).toContainEqual({ name: ENV_AGENT_RUN_AS_UID, value: String(WARREN_POD_AGENT_UID) });
		expect(env).toContainEqual({ name: ENV_AGENT_RUN_AS_GID, value: String(WARREN_POD_GID) });
	});

	test("WARREN_K8S_AGENT_UID_DROP=0 opts out to the legacy shared-uid shape", () => {
		const bare = buildRunPod(baseSpec(), resolveK8sPodConfig({ WARREN_K8S_AGENT_UID_DROP: "0" }));
		const bareAgent = bare.spec?.containers?.[0];
		const bareNames = (bareAgent?.env ?? []).map((e) => e.name);
		expect(bareNames).not.toContain(ENV_AGENT_RUN_AS_UID);
		expect(bareNames).not.toContain(ENV_AGENT_RUN_AS_GID);
		expect(bareAgent?.securityContext?.capabilities).toEqual({ drop: ["ALL"] });
	});
});
