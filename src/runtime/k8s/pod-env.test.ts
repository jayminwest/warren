import { describe, expect, test } from "bun:test";
import type { RunSpec } from "../contract.ts";
import {
	buildRunPodVolumes,
	DEFAULT_REPO_CACHE_MOUNT_PATH,
	REPO_CACHE_VOLUME_NAME,
	resolveRepoCacheConfig,
	serviceDnsCallbackUrl,
} from "./pod-env.ts";
import { buildRunPod, type K8sPodConfig, resolveK8sPodConfig } from "./pod-spec.ts";

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

describe("serviceDnsCallbackUrl", () => {
	test("builds in-cluster Service DNS from the callback coordinates", () => {
		const c = resolveK8sPodConfig({
			WARREN_K8S_CALLBACK_SERVICE: "cp",
			WARREN_K8S_CALLBACK_NAMESPACE: "sys",
			WARREN_K8S_CALLBACK_PORT: "9000",
		});
		expect(serviceDnsCallbackUrl(c)).toBe("http://cp.sys.svc.cluster.local:9000");
	});
});

describe("resolveRepoCacheConfig (warren-e908, §4.3/R2)", () => {
	test("returns undefined when the claim env is absent or blank", () => {
		expect(resolveRepoCacheConfig({})).toBeUndefined();
		expect(resolveRepoCacheConfig({ WARREN_K8S_REPO_CACHE_PVC: "   " })).toBeUndefined();
	});

	test("reads the claim name + default/overridden mount path", () => {
		expect(resolveRepoCacheConfig({ WARREN_K8S_REPO_CACHE_PVC: "warren-repo-cache" })).toEqual({
			claimName: "warren-repo-cache",
			mountPath: DEFAULT_REPO_CACHE_MOUNT_PATH,
		});
		expect(
			resolveRepoCacheConfig({
				WARREN_K8S_REPO_CACHE_PVC: "warren-repo-cache",
				WARREN_K8S_REPO_CACHE_PATH: "/cache",
			}),
		).toEqual({ claimName: "warren-repo-cache", mountPath: "/cache" });
	});
});

describe("buildRunPodVolumes (warren-e908)", () => {
	test("workspace emptyDir only when no seed ConfigMap + no repo cache", () => {
		const volumes = buildRunPodVolumes(config, {});
		expect(volumes).toHaveLength(1);
		expect(volumes[0]?.emptyDir).toBeDefined();
		expect(volumes.some((v) => v.name === REPO_CACHE_VOLUME_NAME)).toBe(false);
	});

	test("appends the repo-cache PVC volume when the cache is configured", () => {
		const cached = resolveK8sPodConfig({ WARREN_K8S_REPO_CACHE_PVC: "warren-repo-cache" });
		const vol = buildRunPodVolumes(cached, {}).find((v) => v.name === REPO_CACHE_VOLUME_NAME);
		expect(vol?.persistentVolumeClaim?.claimName).toBe("warren-repo-cache");
	});
});

describe("repo-cache wiring through buildRunPod (warren-e908, §4.3/R2)", () => {
	test("no PVC volume/mount + no WARREN_REPO_CACHE_DIR env when repoCache is unset", () => {
		const pod = buildRunPod(baseSpec(), config);
		expect(pod.spec?.volumes?.some((v) => v.name === REPO_CACHE_VOLUME_NAME)).toBe(false);
		const init = pod.spec?.initContainers?.[0];
		expect(init?.volumeMounts?.some((m) => m.name === REPO_CACHE_VOLUME_NAME)).toBe(false);
		const env = Object.fromEntries((init?.env ?? []).map((e) => [e.name, e.value]));
		expect(env.WARREN_REPO_CACHE_DIR).toBeUndefined();
	});

	test("repoCache wires a PVC volume + init-only mount + WARREN_REPO_CACHE_DIR env", () => {
		const cached = resolveK8sPodConfig({ WARREN_K8S_REPO_CACHE_PVC: "warren-repo-cache" });
		const pod = buildRunPod(baseSpec(), cached);
		const vol = pod.spec?.volumes?.find((v) => v.name === REPO_CACHE_VOLUME_NAME);
		expect(vol?.persistentVolumeClaim?.claimName).toBe("warren-repo-cache");
		const init = pod.spec?.initContainers?.[0];
		const mount = init?.volumeMounts?.find((m) => m.name === REPO_CACHE_VOLUME_NAME);
		expect(mount).toEqual({
			name: REPO_CACHE_VOLUME_NAME,
			mountPath: DEFAULT_REPO_CACHE_MOUNT_PATH,
		});
		const env = Object.fromEntries((init?.env ?? []).map((e) => [e.name, e.value]));
		expect(env.WARREN_REPO_CACHE_DIR).toBe(DEFAULT_REPO_CACHE_MOUNT_PATH);
		// The agent container must NOT mount the cache — the run workspace is the emptyDir.
		const agent = pod.spec?.containers?.[0];
		expect(agent?.volumeMounts?.some((m) => m.name === REPO_CACHE_VOLUME_NAME)).toBe(false);
	});
});

describe("agent-container env (warren-6016)", () => {
	test("WARREN_GIT_TOKEN rides as an optional secretKeyRef for the salvage window", () => {
		const agent = buildRunPod(baseSpec(), config).spec?.containers?.[0];
		const token = (agent?.env ?? []).find((e) => e.name === "WARREN_GIT_TOKEN");
		expect(token?.valueFrom?.secretKeyRef).toEqual({
			name: config.gitTokenSecret.name,
			key: config.gitTokenSecret.key,
			optional: true,
		});
	});

	test("a domain-supplied WARREN_GIT_TOKEN is not shadowed by the secret ref", () => {
		const pod = buildRunPod(
			baseSpec({ env: { WARREN_API_TOKEN: "tok", WARREN_GIT_TOKEN: "inline-tok" } }),
			config,
		);
		const token = (pod.spec?.containers?.[0]?.env ?? []).filter(
			(e) => e.name === "WARREN_GIT_TOKEN",
		);
		expect(token).toHaveLength(1);
		expect(token[0]?.value).toBe("inline-tok");
		expect(token[0]?.valueFrom).toBeUndefined();
	});

	test("the operator bot-identity override threads onto the agent env, both halves or nothing", () => {
		const withIdentity = buildRunPod(
			baseSpec(),
			resolveK8sPodConfig({ WARREN_BOT_NAME: "acme-bot", WARREN_BOT_EMAIL: "bot@acme.example" }),
		);
		const env = Object.fromEntries(
			(withIdentity.spec?.containers?.[0]?.env ?? []).map((e) => [e.name, e.value]),
		);
		expect(env.WARREN_BOT_NAME).toBe("acme-bot");
		expect(env.WARREN_BOT_EMAIL).toBe("bot@acme.example");
		// A half-set pair is ignored (mirrors resolveWarrenBotIdentity).
		const halfSet = buildRunPod(baseSpec(), resolveK8sPodConfig({ WARREN_BOT_NAME: "acme-bot" }));
		const halfNames = (halfSet.spec?.containers?.[0]?.env ?? []).map((e) => e.name);
		expect(halfNames).not.toContain("WARREN_BOT_NAME");
		expect(halfNames).not.toContain("WARREN_BOT_EMAIL");
		// Unset: neither var rides the pod env; the canonical default applies.
		const defaultNames = (buildRunPod(baseSpec(), config).spec?.containers?.[0]?.env ?? []).map(
			(e) => e.name,
		);
		expect(defaultNames).not.toContain("WARREN_BOT_NAME");
	});
});

describe("generic provider Secret mapping (warren-fb8d)", () => {
	test("a third registry provider maps generically to its own Secret", () => {
		const agent = buildRunPod(baseSpec(), config).spec?.containers?.[0];
		const groq = (agent?.env ?? []).find((e) => e.name === "GROQ_API_KEY");
		expect(groq?.valueFrom?.secretKeyRef).toEqual({
			name: "warren-groq-key",
			key: "api-key",
			optional: true,
		});
	});

	test("provider Secret coordinates honor the per-provider env override", () => {
		const overridden = resolveK8sPodConfig({
			WARREN_K8S_GROQ_SECRET_NAME: "custom-groq",
			WARREN_K8S_GROQ_SECRET_KEY: "creds",
		});
		expect(overridden.providerSecrets.groq).toEqual({ name: "custom-groq", key: "creds" });
		const agent = buildRunPod(baseSpec(), overridden).spec?.containers?.[0];
		const groq = (agent?.env ?? []).find((e) => e.name === "GROQ_API_KEY");
		expect(groq?.valueFrom?.secretKeyRef).toEqual({
			name: "custom-groq",
			key: "creds",
			optional: true,
		});
	});

	test("every registry provider's canonical key rides an optional secretKeyRef", () => {
		const env = buildRunPod(baseSpec(), config).spec?.containers?.[0]?.env ?? [];
		for (const [provider, envKey] of [
			["anthropic", "ANTHROPIC_API_KEY"],
			["openrouter", "OPENROUTER_API_KEY"],
			["groq", "GROQ_API_KEY"],
		] as const) {
			const found = env.find((e) => e.name === envKey);
			expect(found?.valueFrom?.secretKeyRef).toEqual({
				name: `warren-${provider}-key`,
				key: "api-key",
				optional: true,
			});
		}
	});

	test("an unknown provider contributes no secretKeyRef and breaks nothing", () => {
		const pod = buildRunPod(
			baseSpec({ metadata: { frontmatter: { provider: "acme-custom" } } }),
			config,
		);
		const secretRefs = (pod.spec?.containers?.[0]?.env ?? []).filter(
			(e) => e.valueFrom?.secretKeyRef !== undefined,
		);
		for (const ref of secretRefs) {
			expect(ref.valueFrom?.secretKeyRef?.name).toMatch(/^warren-/);
		}
		expect(secretRefs.some((e) => e.name.includes("ACME"))).toBe(false);
	});
});
