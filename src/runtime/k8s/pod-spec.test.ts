import { describe, expect, test } from "bun:test";
import type { DefaultsConfig } from "../../warren-config/index.ts";
import type { RunSpec } from "../contract.ts";
import {
	AGENT_CONTAINER_NAME,
	buildRunPod,
	DEFAULT_K8S_AGENT_IMAGE,
	DEFAULT_K8S_GIT_SECRET_KEY,
	DEFAULT_K8S_GIT_SECRET_NAME,
	DEFAULT_K8S_INIT_IMAGE,
	DEFAULT_K8S_NAMESPACE,
	INIT_CONTAINER_NAME,
	K8S_INIT_COMMAND,
	type K8sPodConfig,
	LABEL_MANAGED_BY,
	LABEL_MODE,
	LABEL_NETWORK,
	LABEL_RUN_ID,
	LABEL_RUNTIME,
	MANAGED_BY_VALUE,
	podLabelsForRun,
	podNameForRun,
	resolveK8sPodConfig,
	SEED_MANIFEST_PATH,
	SEED_MOUNT_PATH,
	SEED_VOLUME_NAME,
	serviceDnsCallbackUrl,
	WARREN_POD_GID,
	WARREN_POD_UID,
	WORKSPACE_MOUNT_PATH,
	WORKSPACE_VOLUME_NAME,
} from "./pod-spec.ts";

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
		env: { PLOT_ID: "plot_1", WARREN_API_TOKEN: "tok" },
		...overrides,
	};
}

const config: K8sPodConfig = resolveK8sPodConfig({});

describe("resolveK8sPodConfig", () => {
	test("falls back to the DEFAULT_K8S_* constants when no config block is present", () => {
		const c = resolveK8sPodConfig({});
		expect(c.namespace).toBe(DEFAULT_K8S_NAMESPACE);
		expect(c.agentImage).toBe(DEFAULT_K8S_AGENT_IMAGE);
		expect(c.initImage).toBe(DEFAULT_K8S_INIT_IMAGE);
		expect(c.uid).toBe(WARREN_POD_UID);
		expect(c.gid).toBe(WARREN_POD_GID);
		expect(c.requests).toEqual({ memoryMiB: 2048, cpuMillicores: 1000 });
		expect(c.limits).toEqual({ memoryMiB: 4096, cpuMillicores: 4000 });
		expect(c.network).toBe("restricted");
		expect(c.serviceAccountName).toBeUndefined();
	});

	test("reads namespace + images from env", () => {
		const c = resolveK8sPodConfig({
			WARREN_K8S_NAMESPACE: "runs-prod",
			WARREN_K8S_AGENT_IMAGE: "ghcr.io/acme/agent:1.2",
			WARREN_K8S_INIT_IMAGE: "ghcr.io/acme/init:1.2",
			WARREN_K8S_SERVICE_ACCOUNT: "warren-run",
		});
		expect(c.namespace).toBe("runs-prod");
		expect(c.agentImage).toBe("ghcr.io/acme/agent:1.2");
		expect(c.initImage).toBe("ghcr.io/acme/init:1.2");
		expect(c.serviceAccountName).toBe("warren-run");
	});

	test("blank env values fall back to defaults (not empty strings)", () => {
		const c = resolveK8sPodConfig({ WARREN_K8S_NAMESPACE: "   ", WARREN_K8S_SERVICE_ACCOUNT: "" });
		expect(c.namespace).toBe(DEFAULT_K8S_NAMESPACE);
		expect(c.serviceAccountName).toBeUndefined();
	});

	test("callback + git-secret fall back to defaults", () => {
		const c = resolveK8sPodConfig({});
		expect(c.callback).toEqual({ service: "warren", namespace: "warren", port: "8080" });
		expect(c.gitTokenSecret).toEqual({
			name: DEFAULT_K8S_GIT_SECRET_NAME,
			key: DEFAULT_K8S_GIT_SECRET_KEY,
		});
	});

	test("teardown grace periods default to 30s (cancel) / 0s (terminate)", () => {
		const c = resolveK8sPodConfig({});
		expect(c.cancelGracePeriodSeconds).toBe(30);
		expect(c.terminateGracePeriodSeconds).toBe(0);
	});

	test("teardown grace periods read non-negative integers from env", () => {
		const c = resolveK8sPodConfig({
			WARREN_K8S_CANCEL_GRACE_SECONDS: "12",
			WARREN_K8S_TERMINATE_GRACE_SECONDS: "3",
		});
		expect(c.cancelGracePeriodSeconds).toBe(12);
		expect(c.terminateGracePeriodSeconds).toBe(3);
	});

	test("invalid grace env (negative / non-integer / blank) falls back to the default", () => {
		expect(
			resolveK8sPodConfig({ WARREN_K8S_CANCEL_GRACE_SECONDS: "-5" }).cancelGracePeriodSeconds,
		).toBe(30);
		expect(
			resolveK8sPodConfig({ WARREN_K8S_CANCEL_GRACE_SECONDS: "1.5" }).cancelGracePeriodSeconds,
		).toBe(30);
		expect(
			resolveK8sPodConfig({ WARREN_K8S_CANCEL_GRACE_SECONDS: "  " }).cancelGracePeriodSeconds,
		).toBe(30);
		expect(
			resolveK8sPodConfig({ WARREN_K8S_CANCEL_GRACE_SECONDS: "abc" }).cancelGracePeriodSeconds,
		).toBe(30);
	});

	test("callback + git-secret read from env", () => {
		const c = resolveK8sPodConfig({
			WARREN_K8S_CALLBACK_SERVICE: "cp",
			WARREN_K8S_CALLBACK_NAMESPACE: "sys",
			WARREN_K8S_CALLBACK_PORT: "9000",
			WARREN_K8S_GIT_SECRET_NAME: "gh",
			WARREN_K8S_GIT_SECRET_KEY: "pat",
		});
		expect(serviceDnsCallbackUrl(c)).toBe("http://cp.sys.svc.cluster.local:9000");
		expect(c.gitTokenSecret).toEqual({ name: "gh", key: "pat" });
	});

	test("sources resources + network from the .warren/config.yaml resources block", () => {
		const defaults: DefaultsConfig = {
			resources: {
				requests: { memoryMiB: 512, cpuMillicores: 250 },
				limits: { memoryMiB: 8192, cpuMillicores: 8000 },
				network: "none",
			},
		};
		const c = resolveK8sPodConfig({}, defaults);
		expect(c.requests).toEqual({ memoryMiB: 512, cpuMillicores: 250 });
		expect(c.limits).toEqual({ memoryMiB: 8192, cpuMillicores: 8000 });
		expect(c.network).toBe("none");
	});
});

describe("podNameForRun", () => {
	test("sanitizes the run id to a DNS-1123 name (underscores are illegal in names)", () => {
		expect(podNameForRun("run_01tdf3a0wg5e")).toBe("run-run-01tdf3a0wg5e");
	});

	test("lowercases and collapses illegal chars", () => {
		expect(podNameForRun("Run_ABC__123")).toBe("run-run-abc-123");
	});

	test("never contains an underscore or uppercase char", () => {
		const name = podNameForRun("run_Zz_99");
		expect(name).not.toMatch(/[_A-Z]/);
	});

	test("truncates to the 253-char DNS-1123 ceiling without a trailing dash", () => {
		const name = podNameForRun("x".repeat(400));
		expect(name.length).toBeLessThanOrEqual(253);
		expect(name.endsWith("-")).toBe(false);
	});
});

describe("podLabelsForRun", () => {
	test("stamps the warren.io labels; run-id keeps the EXACT run id (underscores legal in values)", () => {
		const labels = podLabelsForRun(baseSpec(), config);
		expect(labels[LABEL_RUN_ID]).toBe("run_01tdf3a0wg5e");
		expect(labels[LABEL_RUNTIME]).toBe("claude-code");
		expect(labels[LABEL_MODE]).toBe("batch");
		expect(labels[LABEL_NETWORK]).toBe("restricted");
		expect(labels[LABEL_MANAGED_BY]).toBe(MANAGED_BY_VALUE);
	});

	test("network label reflects the resolved config network, not the RunSpec intent", () => {
		const defaults: DefaultsConfig = {
			resources: {
				requests: { memoryMiB: 2048, cpuMillicores: 1000 },
				limits: { memoryMiB: 4096, cpuMillicores: 4000 },
				network: "open",
			},
		};
		const c = resolveK8sPodConfig({}, defaults);
		const labels = podLabelsForRun(baseSpec({ network: "none" }), c);
		expect(labels[LABEL_NETWORK]).toBe("open");
	});
});

describe("buildRunPod", () => {
	test("is a bare Pod with restartPolicy: Never (design §1.2 — not a Job)", () => {
		const pod = buildRunPod(baseSpec(), config);
		expect(pod.apiVersion).toBe("v1");
		expect(pod.kind).toBe("Pod");
		expect(pod.spec?.restartPolicy).toBe("Never");
	});

	test("names the pod run-<sanitized-id> in the configured namespace", () => {
		const pod = buildRunPod(baseSpec(), config);
		expect(pod.metadata?.name).toBe("run-run-01tdf3a0wg5e");
		expect(pod.metadata?.namespace).toBe(DEFAULT_K8S_NAMESPACE);
		expect(pod.metadata?.labels?.[LABEL_RUN_ID]).toBe("run_01tdf3a0wg5e");
	});

	test("pod-level securityContext is non-root uid/gid 1000 + RuntimeDefault seccomp", () => {
		const sc = buildRunPod(baseSpec(), config).spec?.securityContext;
		expect(sc?.runAsNonRoot).toBe(true);
		expect(sc?.runAsUser).toBe(1000);
		expect(sc?.runAsGroup).toBe(1000);
		expect(sc?.fsGroup).toBe(1000);
		expect(sc?.seccompProfile?.type).toBe("RuntimeDefault");
	});

	test("every container drops ALL caps, forbids privilege escalation, runs non-root + seccomp", () => {
		const pod = buildRunPod(baseSpec(), config);
		const containers = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])];
		expect(containers.length).toBe(2);
		for (const c of containers) {
			const sc = c.securityContext;
			expect(sc?.allowPrivilegeEscalation).toBe(false);
			expect(sc?.capabilities?.drop).toEqual(["ALL"]);
			expect(sc?.runAsNonRoot).toBe(true);
			expect(sc?.runAsUser).toBe(1000);
			expect(sc?.seccompProfile?.type).toBe("RuntimeDefault");
		}
	});

	test("references a workspace-init init container sharing the /workspace emptyDir", () => {
		const pod = buildRunPod(baseSpec(), config);
		const init = pod.spec?.initContainers?.[0];
		expect(init?.name).toBe(INIT_CONTAINER_NAME);
		expect(init?.image).toBe(DEFAULT_K8S_INIT_IMAGE);
		expect(init?.volumeMounts?.[0]).toEqual({
			name: WORKSPACE_VOLUME_NAME,
			mountPath: WORKSPACE_MOUNT_PATH,
		});
		// The init container gets the git coordinates the materializer needs (step 15).
		const env = Object.fromEntries((init?.env ?? []).map((e) => [e.name, e.value]));
		expect(env.WARREN_RUN_ID).toBe("run_01tdf3a0wg5e");
		expect(env.WARREN_REPO_URL).toBe("https://github.com/acme/widgets.git");
		expect(env.WARREN_BRANCH).toBe("warren/run_01tdf3a0wg5e");
		expect(env.WARREN_BASE_BRANCH).toBe("main");
	});

	test("the workspace volume is an emptyDir mounted by both containers", () => {
		const pod = buildRunPod(baseSpec(), config);
		const vol = pod.spec?.volumes?.[0];
		expect(vol?.name).toBe(WORKSPACE_VOLUME_NAME);
		expect(vol?.emptyDir).toBeDefined();
		const agent = pod.spec?.containers?.[0];
		expect(agent?.name).toBe(AGENT_CONTAINER_NAME);
		expect(agent?.workingDir).toBe(WORKSPACE_MOUNT_PATH);
		expect(agent?.volumeMounts?.[0]?.mountPath).toBe(WORKSPACE_MOUNT_PATH);
	});

	test("agent resources map config requests/limits to K8s quantity strings", () => {
		const pod = buildRunPod(baseSpec(), config);
		const res = pod.spec?.containers?.[0]?.resources;
		expect(res?.requests).toEqual({ memory: "2048Mi", cpu: "1000m" });
		expect(res?.limits).toEqual({ memory: "4096Mi", cpu: "4000m" });
	});

	test("RunSpec.resources overrides the limit; requests clamp so they never exceed it", () => {
		const pod = buildRunPod(
			baseSpec({ resources: { memoryMiB: 1024, cpuMillicores: 500 } }),
			config,
		);
		const res = pod.spec?.containers?.[0]?.resources;
		expect(res?.limits).toEqual({ memory: "1024Mi", cpu: "500m" });
		// config requests were 2048Mi/1000m — clamped down to the lowered limit.
		expect(res?.requests).toEqual({ memory: "1024Mi", cpu: "500m" });
	});

	test("a partial RunSpec.resources override only touches the dimension it sets", () => {
		const pod = buildRunPod(baseSpec({ resources: { memoryMiB: 1024 } }), config);
		const res = pod.spec?.containers?.[0]?.resources;
		expect(res?.limits).toEqual({ memory: "1024Mi", cpu: "4000m" });
		// memory request clamps to 1024; cpu request stays at the config default.
		expect(res?.requests).toEqual({ memory: "1024Mi", cpu: "1000m" });
	});

	test("env vars are name-sorted for a deterministic spec", () => {
		const pod = buildRunPod(baseSpec({ env: { ZED: "1", ALPHA: "2", MID: "3" } }), config);
		const names = (pod.spec?.containers?.[0]?.env ?? []).map((e) => e.name);
		expect(names).toEqual(["ALPHA", "MID", "ZED"]);
	});

	test("no ServiceAccount by default → token automount disabled", () => {
		const pod = buildRunPod(baseSpec(), config);
		expect(pod.spec?.serviceAccountName).toBeUndefined();
		expect(pod.spec?.automountServiceAccountToken).toBe(false);
	});

	test("a configured ServiceAccount is set and re-enables token automount", () => {
		const c = resolveK8sPodConfig({ WARREN_K8S_SERVICE_ACCOUNT: "warren-run" });
		const pod = buildRunPod(baseSpec(), c);
		expect(pod.spec?.serviceAccountName).toBe("warren-run");
		expect(pod.spec?.automountServiceAccountToken).toBe(true);
	});

	test("the init container runs the workspace:init entry command", () => {
		const init = buildRunPod(baseSpec(), config).spec?.initContainers?.[0];
		expect(init?.command).toEqual([...K8S_INIT_COMMAND]);
	});

	test("the init container carries the workspace path + an OPTIONAL git-token secret ref", () => {
		const init = buildRunPod(baseSpec(), config).spec?.initContainers?.[0];
		const env = Object.fromEntries((init?.env ?? []).map((e) => [e.name, e.value]));
		expect(env.WARREN_WORKSPACE_PATH).toBe(WORKSPACE_MOUNT_PATH);
		const tokenVar = (init?.env ?? []).find((e) => e.name === "WARREN_GIT_TOKEN");
		expect(tokenVar?.valueFrom?.secretKeyRef).toEqual({
			name: DEFAULT_K8S_GIT_SECRET_NAME,
			key: DEFAULT_K8S_GIT_SECRET_KEY,
			optional: true,
		});
	});

	test("init env is name-sorted for a deterministic spec", () => {
		const init = buildRunPod(baseSpec(), config).spec?.initContainers?.[0];
		const names = (init?.env ?? []).map((e) => e.name);
		expect(names).toEqual([...names].sort());
	});

	test("no seed volume/mount + no manifest env when there is no seed ConfigMap", () => {
		const pod = buildRunPod(baseSpec(), config);
		expect(pod.spec?.volumes?.some((v) => v.name === SEED_VOLUME_NAME)).toBe(false);
		const init = pod.spec?.initContainers?.[0];
		expect(init?.volumeMounts?.some((m) => m.name === SEED_VOLUME_NAME)).toBe(false);
		const env = Object.fromEntries((init?.env ?? []).map((e) => [e.name, e.value]));
		expect(env.WARREN_SEED_MANIFEST).toBeUndefined();
	});

	test("opts.seedConfigMapName wires a read-only ConfigMap volume + init mount + manifest env", () => {
		const pod = buildRunPod(baseSpec(), config, { seedConfigMapName: "run-run-x-seeds" });
		const vol = pod.spec?.volumes?.find((v) => v.name === SEED_VOLUME_NAME);
		expect(vol?.configMap?.name).toBe("run-run-x-seeds");
		const init = pod.spec?.initContainers?.[0];
		const mount = init?.volumeMounts?.find((m) => m.name === SEED_VOLUME_NAME);
		expect(mount).toEqual({ name: SEED_VOLUME_NAME, mountPath: SEED_MOUNT_PATH, readOnly: true });
		const env = Object.fromEntries((init?.env ?? []).map((e) => [e.name, e.value]));
		expect(env.WARREN_SEED_MANIFEST).toBe(SEED_MANIFEST_PATH);
	});
});
