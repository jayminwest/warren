import { describe, expect, test } from "bun:test";
import { uidDropPreflightArgv } from "../src/runtime/k8s/agent-uid-drop.ts";
import {
	agentContainerSecurityContext,
	LABEL_MANAGED_BY,
	resolveK8sPodConfig,
} from "../src/runtime/k8s/pod-spec.ts";
import {
	buildUidDropCanaryPod,
	CANARY_LABEL_KEY,
	CANARY_LABEL_VALUE,
	CANARY_POD_NAME,
} from "./k8s-uid-drop-canary.ts";

describe("buildUidDropCanaryPod (warren-950d)", () => {
	const pod = buildUidDropCanaryPod({ image: "warren-agent:sha", namespace: "warren-runs" });

	test("derives the probe command and container posture from the run-pod builders", () => {
		const config = resolveK8sPodConfig({});
		const drop = config.agentUidDrop;
		expect(drop).toBeDefined();
		const container = pod.spec?.containers?.[0];
		if (drop === undefined) throw new Error("unreachable");
		// The exact preflight the entrypoint runs before spawning the agent —
		// and the exact securityContext dispatch stamps on the agent container.
		expect(container?.command).toEqual(uidDropPreflightArgv(drop));
		expect(container?.securityContext).toEqual(agentContainerSecurityContext(config));
		expect(container?.image).toBe("warren-agent:sha");
		expect(pod.metadata?.namespace).toBe("warren-runs");
		expect(pod.metadata?.name).toBe(CANARY_POD_NAME);
	});

	test("stays invisible to the pod-watcher and admission gate", () => {
		const labels = pod.metadata?.labels ?? {};
		expect(labels[CANARY_LABEL_KEY]).toBe(CANARY_LABEL_VALUE);
		expect(Object.keys(labels)).not.toContain(LABEL_MANAGED_BY);
	});

	test("terminal-by-design: restartPolicy Never, no service account token", () => {
		expect(pod.spec?.restartPolicy).toBe("Never");
		expect(pod.spec?.automountServiceAccountToken).toBe(false);
	});

	test("refuses to canary a config with the split disabled", () => {
		expect(() =>
			buildUidDropCanaryPod({
				image: "warren-agent:sha",
				namespace: "warren-runs",
				config: resolveK8sPodConfig({ WARREN_K8S_AGENT_UID_DROP: "0" }),
			}),
		).toThrow("uid split disabled");
	});
});
