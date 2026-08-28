import { describe, expect, test } from "bun:test";
import type { ResourcesConfig } from "../../warren-config/index.ts";
import type { RunSpec } from "../contract.ts";
import {
	AGENT_CONTAINER_NAME,
	buildRunPod,
	DEFAULT_K8S_AGENT_IMAGE,
	DEFAULT_K8S_GIT_SECRET_KEY,
	DEFAULT_K8S_GIT_SECRET_NAME,
	DEFAULT_K8S_INIT_IMAGE,
	DEFAULT_K8S_NAMESPACE,
	ENV_AGENT_METADATA,
	ENV_AGENT_RUNTIME,
	ENV_PROMPT,
	ENV_RUN_ID,
	ENV_WORKSPACE_PATH,
	INIT_CONTAINER_NAME,
	K8S_AGENT_COMMAND,
	K8S_INIT_COMMAND,
	type K8sPodConfig,
	LABEL_MANAGED_BY,
	LABEL_MODE,
	LABEL_NETWORK,
	LABEL_PROJECT,
	LABEL_RUN_ID,
	LABEL_RUNTIME,
	MANAGED_BY_VALUE,
	podLabelsForRun,
	podNameForRun,
	resolveK8sPodConfig,
	SEED_MANIFEST_PATH,
	SEED_MOUNT_PATH,
	SEED_VOLUME_NAME,
	sanitizeLabelValue,
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
		expect(c.requests).toEqual({
			memoryMiB: 2048,
			cpuMillicores: 1000,
			ephemeralStorageMiB: 10_240,
		});
		expect(c.limits).toEqual({ memoryMiB: 4096, cpuMillicores: 4000, ephemeralStorageMiB: 10_240 });
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

	test("imagePullPolicy: absent env ⇒ undefined; valid ⇒ set; invalid/blank ⇒ undefined (warren-245d)", () => {
		expect(resolveK8sPodConfig({}).imagePullPolicy).toBeUndefined();
		expect(
			resolveK8sPodConfig({ WARREN_K8S_IMAGE_PULL_POLICY: "IfNotPresent" }).imagePullPolicy,
		).toBe("IfNotPresent");
		expect(resolveK8sPodConfig({ WARREN_K8S_IMAGE_PULL_POLICY: "Never" }).imagePullPolicy).toBe(
			"Never",
		);
		expect(
			resolveK8sPodConfig({ WARREN_K8S_IMAGE_PULL_POLICY: "bogus" }).imagePullPolicy,
		).toBeUndefined();
		expect(
			resolveK8sPodConfig({ WARREN_K8S_IMAGE_PULL_POLICY: "  " }).imagePullPolicy,
		).toBeUndefined();
	});

	test("callback + git-secret fall back to defaults", () => {
		const c = resolveK8sPodConfig({});
		expect(c.callback).toEqual({ service: "warren", namespace: "warren", port: "8080" });
		expect(c.gitTokenSecret).toEqual({
			name: DEFAULT_K8S_GIT_SECRET_NAME,
			key: DEFAULT_K8S_GIT_SECRET_KEY,
		});
	});

	test("teardown grace periods default to 90s (cancel) / 0s (terminate)", () => {
		const c = resolveK8sPodConfig({});
		expect(c.cancelGracePeriodSeconds).toBe(90);
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
		).toBe(90);
		expect(
			resolveK8sPodConfig({ WARREN_K8S_CANCEL_GRACE_SECONDS: "1.5" }).cancelGracePeriodSeconds,
		).toBe(90);
		expect(
			resolveK8sPodConfig({ WARREN_K8S_CANCEL_GRACE_SECONDS: "  " }).cancelGracePeriodSeconds,
		).toBe(90);
		expect(
			resolveK8sPodConfig({ WARREN_K8S_CANCEL_GRACE_SECONDS: "abc" }).cancelGracePeriodSeconds,
		).toBe(90);
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

	// Resource-block resolution (incl. ephemeral-storage) is covered in
	// `pod-resources.test.ts` alongside the extracted quantity helpers (warren-653f).
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

	test("omits the project label when the RunSpec has no projectId (warren-b6f2)", () => {
		expect(podLabelsForRun(baseSpec(), config)[LABEL_PROJECT]).toBeUndefined();
	});

	test("stamps the project label from RunSpec.projectId (warren-b6f2)", () => {
		const labels = podLabelsForRun(baseSpec({ projectId: "proj_01hxyz" }), config);
		expect(labels[LABEL_PROJECT]).toBe("proj_01hxyz");
	});

	test("network label reflects the resolved config network, not the RunSpec intent", () => {
		const resources: ResourcesConfig = {
			requests: { memoryMiB: 2048, cpuMillicores: 1000 },
			limits: { memoryMiB: 4096, cpuMillicores: 4000 },
			network: "open",
		};
		const c = resolveK8sPodConfig({}, resources);
		const labels = podLabelsForRun(baseSpec({ network: "none" }), c);
		expect(labels[LABEL_NETWORK]).toBe("open");
	});
});

describe("sanitizeLabelValue", () => {
	test("passes a normal project id through unchanged", () => {
		expect(sanitizeLabelValue("proj_01hxyz")).toBe("proj_01hxyz");
	});
	test("collapses illegal chars to '-' and trims edges", () => {
		expect(sanitizeLabelValue("a/b c!d")).toBe("a-b-c-d");
		expect(sanitizeLabelValue("--x--")).toBe("x");
	});
	test("blank / all-illegal input yields undefined (no label stamped)", () => {
		expect(sanitizeLabelValue(undefined)).toBeUndefined();
		expect(sanitizeLabelValue("")).toBeUndefined();
		expect(sanitizeLabelValue("///")).toBeUndefined();
	});
	test("truncates to 63 chars", () => {
		expect(sanitizeLabelValue("a".repeat(80))).toHaveLength(63);
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

	test("stamps the run branch as the warren.io/branch annotation (warren-e9e1)", () => {
		const pod = buildRunPod(baseSpec(), config);
		expect(pod.metadata?.annotations?.["warren.io/branch"]).toBe("warren/run_01tdf3a0wg5e");
	});

	test("omits the branch annotation when the spec carries no branch", () => {
		const pod = buildRunPod(baseSpec({ branch: "" }), config);
		expect(pod.metadata?.annotations?.["warren.io/branch"]).toBeUndefined();
	});

	test("agent image precedence: spec.agentImage > env config (warren-fabb)", () => {
		// config.agentImage here comes from WARREN_K8S_AGENT_IMAGE — the
		// per-project override must win, and fall back to it when absent.
		const withEnvImage = resolveK8sPodConfig({ WARREN_K8S_AGENT_IMAGE: "ghcr.io/acme/agent:1.2" });
		const overridden = buildRunPod(
			baseSpec({ agentImage: "ghcr.io/acme/agent-py:1.0" }),
			withEnvImage,
		);
		expect(overridden.spec?.containers?.[0]?.image).toBe("ghcr.io/acme/agent-py:1.0");

		const fallback = buildRunPod(baseSpec(), withEnvImage);
		expect(fallback.spec?.containers?.[0]?.image).toBe("ghcr.io/acme/agent:1.2");
	});

	test("imagePullPolicy: omitted by default, applied to BOTH containers when set (warren-245d)", () => {
		const bare = buildRunPod(baseSpec(), config);
		expect(bare.spec?.initContainers?.[0]?.imagePullPolicy).toBeUndefined();
		expect(bare.spec?.containers?.[0]?.imagePullPolicy).toBeUndefined();

		const local = resolveK8sPodConfig({ WARREN_K8S_IMAGE_PULL_POLICY: "IfNotPresent" });
		const pod = buildRunPod(baseSpec(), local);
		expect(pod.spec?.initContainers?.[0]?.imagePullPolicy).toBe("IfNotPresent");
		expect(pod.spec?.containers?.[0]?.imagePullPolicy).toBe("IfNotPresent");
	});

	test("pod-level securityContext is non-root uid/gid 1000 + RuntimeDefault seccomp", () => {
		const sc = buildRunPod(baseSpec(), config).spec?.securityContext;
		expect(sc?.runAsNonRoot).toBe(true);
		expect(sc?.runAsUser).toBe(1000);
		expect(sc?.runAsGroup).toBe(1000);
		expect(sc?.fsGroup).toBe(1000);
		expect(sc?.seccompProfile?.type).toBe("RuntimeDefault");
	});

	test("every container drops ALL caps, runs non-root + seccomp", () => {
		const pod = buildRunPod(baseSpec(), config);
		const containers = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])];
		expect(containers.length).toBe(2);
		for (const c of containers) {
			const sc = c.securityContext;
			expect(sc?.capabilities?.drop).toEqual(["ALL"]);
			expect(sc?.runAsNonRoot).toBe(true);
			expect(sc?.runAsUser).toBe(1000);
			expect(sc?.seccompProfile?.type).toBe("RuntimeDefault");
		}
		// The agent container's uid-split relaxation: pod-spec.uid-drop.test.ts (warren-950d).
		expect(pod.spec?.initContainers?.[0]?.securityContext?.allowPrivilegeEscalation).toBe(false);
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
		// warren-653f: the emptyDir is capped at the ephemeral-storage limit so a
		// workspace overrun fails the volume first (crisp signal), not just the pod.
		expect(vol?.emptyDir?.sizeLimit).toBe("10240Mi");
		const agent = pod.spec?.containers?.[0];
		expect(agent?.name).toBe(AGENT_CONTAINER_NAME);
		// warren-245d: the agent container must NOT override workingDir — it starts
		// in the image WORKDIR (/app) so `bun run agent:run` resolves; the agent is
		// spawned in /workspace by agent-entrypoint (cwd: WARREN_WORKSPACE_PATH).
		expect(agent?.workingDir).toBeUndefined();
		expect(agent?.volumeMounts?.[0]?.mountPath).toBe(WORKSPACE_MOUNT_PATH);
	});

	// Agent/init resource rendering + per-run overrides live in
	// `pod-resources.test.ts` (warren-653f).

	test("env vars are name-sorted for a deterministic spec", () => {
		const pod = buildRunPod(baseSpec({ env: { ZED: "1", ALPHA: "2", MID: "3" } }), config);
		const names = (pod.spec?.containers?.[0]?.env ?? []).map((e) => e.name);
		// The domain vars ride alongside the derived run-contract vars, all sorted.
		expect(names).toEqual([...names].sort());
		expect(names).toEqual(expect.arrayContaining(["ALPHA", "MID", "ZED"]));
	});

	test("the agent container runs the agent-runner entry command", () => {
		const agent = buildRunPod(baseSpec(), config).spec?.containers?.[0];
		expect(agent?.command).toEqual([...K8S_AGENT_COMMAND]);
	});

	test("agent env threads the in-pod runner contract (run-id, workspace, runtime, prompt)", () => {
		const pod = buildRunPod(baseSpec({ runtimeId: "sapling", prompt: "fix the bug" }), config);
		const env = Object.fromEntries(
			(pod.spec?.containers?.[0]?.env ?? []).map((e) => [e.name, e.value]),
		);
		expect(env[ENV_RUN_ID]).toBe("run_01tdf3a0wg5e");
		expect(env[ENV_WORKSPACE_PATH]).toBe(WORKSPACE_MOUNT_PATH);
		expect(env[ENV_AGENT_RUNTIME]).toBe("sapling");
		expect(env[ENV_PROMPT]).toBe("fix the bug");
		// Domain env survives (the provider folds WARREN_API_URL/TOKEN into spec.env).
		expect(env.WARREN_API_TOKEN).toBe("tok");
		expect(env.PLOT_ID).toBe("plot_1");
	});

	test("agent env satisfies the finalize entrypoint's required contract", () => {
		// finalize-entrypoint requires RUN_ID + API_URL + API_TOKEN + WORKSPACE_PATH.
		const pod = buildRunPod(
			baseSpec({
				env: { WARREN_API_TOKEN: "tok", WARREN_API_URL: "http://warren.warren.svc:8080" },
			}),
			config,
		);
		const env = Object.fromEntries(
			(pod.spec?.containers?.[0]?.env ?? []).map((e) => [e.name, e.value]),
		);
		expect(env[ENV_RUN_ID]).toBeDefined();
		expect(env[ENV_WORKSPACE_PATH]).toBeDefined();
		expect(env.WARREN_API_URL).toBe("http://warren.warren.svc:8080");
		expect(env.WARREN_API_TOKEN).toBe("tok");
	});

	test("WARREN_AGENT_METADATA carries the run metadata as JSON when present", () => {
		const pod = buildRunPod(baseSpec({ metadata: { frontmatter: { model: "opus" } } }), config);
		const meta = (pod.spec?.containers?.[0]?.env ?? []).find((e) => e.name === ENV_AGENT_METADATA);
		expect(meta?.value).toBe(JSON.stringify({ frontmatter: { model: "opus" } }));
	});

	test("ANTHROPIC_API_KEY rides as an optional secretKeyRef by default", () => {
		const agent = buildRunPod(baseSpec(), config).spec?.containers?.[0];
		const anthropic = (agent?.env ?? []).find((e) => e.name === "ANTHROPIC_API_KEY");
		expect(anthropic?.valueFrom?.secretKeyRef).toEqual({
			name: "warren-anthropic-key",
			key: "api-key",
			optional: true,
		});
	});

	test("a domain-supplied ANTHROPIC_API_KEY is not shadowed by the secret ref", () => {
		const pod = buildRunPod(
			baseSpec({ env: { WARREN_API_TOKEN: "tok", ANTHROPIC_API_KEY: "sk-inline" } }),
			config,
		);
		const anthropic = (pod.spec?.containers?.[0]?.env ?? []).filter(
			(e) => e.name === "ANTHROPIC_API_KEY",
		);
		expect(anthropic).toHaveLength(1);
		expect(anthropic[0]?.value).toBe("sk-inline");
		expect(anthropic[0]?.valueFrom).toBeUndefined();
	});

	test("OPENROUTER_API_KEY rides as an optional secretKeyRef by default", () => {
		const agent = buildRunPod(baseSpec(), config).spec?.containers?.[0];
		const openrouter = (agent?.env ?? []).find((e) => e.name === "OPENROUTER_API_KEY");
		expect(openrouter?.valueFrom?.secretKeyRef).toEqual({
			name: "warren-openrouter-key",
			key: "api-key",
			optional: true,
		});
	});

	test("a domain-supplied OPENROUTER_API_KEY is not shadowed by the secret ref", () => {
		const pod = buildRunPod(
			baseSpec({ env: { WARREN_API_TOKEN: "tok", OPENROUTER_API_KEY: "sk-or-inline" } }),
			config,
		);
		const openrouter = (pod.spec?.containers?.[0]?.env ?? []).filter(
			(e) => e.name === "OPENROUTER_API_KEY",
		);
		expect(openrouter).toHaveLength(1);
		expect(openrouter[0]?.value).toBe("sk-or-inline");
		expect(openrouter[0]?.valueFrom).toBeUndefined();
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
