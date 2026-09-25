import { describe, expect, test } from "bun:test";
import { ResourcesConfigSchema } from "../../warren-config/resources-config.ts";
import type { RunSpec } from "../contract.ts";
import { SANDBOXED_ENTRYPOINT_UID, sandboxedAgentSecurityContext } from "./pod-runtime-class.ts";
import { AGENT_CONTAINER_NAME, buildRunPod, resolveK8sPodConfig } from "./pod-spec.ts";

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
		env: {},
		...overrides,
	};
}

function agentOf(pod: ReturnType<typeof buildRunPod>) {
	const agent = pod.spec?.containers.find((c) => c.name === AGENT_CONTAINER_NAME);
	if (agent === undefined) throw new Error("no agent container");
	return agent;
}

describe("buildRunPod with resources.runtimeClass (warren-9bd3)", () => {
	test("no runtimeClass leaves the pod on the default runtime with the file-caps uid split", () => {
		const pod = buildRunPod(baseSpec(), resolveK8sPodConfig({}));
		expect(pod.spec?.runtimeClassName).toBeUndefined();
		expect(agentOf(pod).securityContext?.allowPrivilegeEscalation).toBe(true);
		expect(agentOf(pod).securityContext?.runAsUser).toBe(1000);
	});

	test("a runtimeClass sets runtimeClassName and the sandbox-compatible agent posture", () => {
		const pod = buildRunPod(baseSpec(), resolveK8sPodConfig({}, { runtimeClass: "gvisor" }));
		expect(pod.spec?.runtimeClassName).toBe("gvisor");
		const ctx = agentOf(pod).securityContext;
		expect(ctx?.allowPrivilegeEscalation).toBe(false);
		expect(ctx?.runAsUser).toBe(SANDBOXED_ENTRYPOINT_UID);
		expect(ctx?.runAsNonRoot).toBe(false);
		expect(ctx?.capabilities).toEqual({ drop: ["ALL"], add: ["SETUID", "SETGID", "KILL"] });
		expect(ctx?.seccompProfile).toEqual({ type: "RuntimeDefault" });
	});

	test("the agent still drops to its own uid under a runtimeClass", () => {
		const pod = buildRunPod(baseSpec(), resolveK8sPodConfig({}, { runtimeClass: "gvisor" }));
		const env = agentOf(pod).env ?? [];
		expect(env.find((e) => e.name === "WARREN_AGENT_RUN_AS_UID")?.value).toBe("1001");
	});

	test("the init container and the pod-level context stay non-root", () => {
		const pod = buildRunPod(baseSpec(), resolveK8sPodConfig({}, { runtimeClass: "gvisor" }));
		expect(pod.spec?.securityContext?.runAsNonRoot).toBe(true);
		const init = pod.spec?.initContainers?.[0]?.securityContext;
		expect(init?.runAsUser).toBe(1000);
		expect(init?.runAsNonRoot).toBe(true);
		expect(init?.allowPrivilegeEscalation).toBe(false);
	});

	test("with the uid split disabled the agent keeps the non-root default", () => {
		const pod = buildRunPod(
			baseSpec(),
			resolveK8sPodConfig({ WARREN_K8S_AGENT_UID_DROP: "0" }, { runtimeClass: "gvisor" }),
		);
		const ctx = agentOf(pod).securityContext;
		expect(ctx?.runAsUser).toBe(1000);
		expect(ctx?.runAsNonRoot).toBe(true);
		expect(ctx?.allowPrivilegeEscalation).toBe(false);
	});

	test("composes with Spot placement", () => {
		const pod = buildRunPod(
			baseSpec(),
			resolveK8sPodConfig({ WARREN_K8S_SPOT: "1" }, { runtimeClass: "gvisor" }),
		);
		expect(pod.spec?.runtimeClassName).toBe("gvisor");
		expect(pod.spec?.nodeSelector).toEqual({ "cloud.google.com/gke-spot": "true" });
	});
});

describe("sandboxedAgentSecurityContext", () => {
	test("never enables privilege escalation", () => {
		expect(
			sandboxedAgentSecurityContext({ allowPrivilegeEscalation: true }, false)
				.allowPrivilegeEscalation,
		).toBe(false);
		expect(
			sandboxedAgentSecurityContext({ allowPrivilegeEscalation: true }, true)
				.allowPrivilegeEscalation,
		).toBe(false);
	});
});

describe("ResourcesConfigSchema runtimeClass", () => {
	test("accepts RuntimeClass names", () => {
		for (const name of ["gvisor", "kata-qemu", "runsc.v1"]) {
			expect(ResourcesConfigSchema.safeParse({ runtimeClass: name }).success).toBe(true);
		}
	});

	test("rejects names that are not DNS-1123 subdomains", () => {
		for (const name of ["", "GVisor", "-gvisor", "gvisor_", "a b"]) {
			expect(ResourcesConfigSchema.safeParse({ runtimeClass: name }).success).toBe(false);
		}
	});
});
