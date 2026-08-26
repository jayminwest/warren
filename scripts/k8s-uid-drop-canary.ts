/**
 * Live uid-drop canary for the K8s runtime (warren-950d).
 *
 * Proves — against the real cluster, with the real agent image — that the
 * entrypoint/agent uid split (warren-cb93, `src/runtime/k8s/agent-uid-drop.ts`)
 * can actually privilege its setpriv drop, BEFORE any run is dispatched. The
 * failure this catches burned the live dogfood pipeline on 2026-08-25: a GKE
 * node auto-upgrade moved the runtime to containerd 2.x, which grants a
 * non-root pid 1 its `capabilities.add` in the bounding set only, so every
 * run died at the preflight (`setpriv exited 127`) after deploy.
 *
 * The canary pod is a function of the SAME modules the run pod is built
 * from — `agentContainerSecurityContext` for the container posture and
 * `uidDropPreflightArgv` for the probe command — so the gate cannot drift
 * from what dispatch will do. The probe IS the pod command: phase
 * `Succeeded` means the drop works; anything else fails the deploy with the
 * pod's logs in the output.
 *
 * Usage (deploy-gke.yml runs this after the rollout):
 *
 *   bun run scripts/k8s-uid-drop-canary.ts --image <agent-image> \
 *     [--namespace warren-runs] [--timeout-seconds 300]
 *
 * The pod carries `warren.io/canary: uid-drop` and never the
 * `warren.io/managed-by: warren` label, so the pod-watcher informer and the
 * admission gate ignore it.
 */

import type { V1Pod } from "@kubernetes/client-node";
import { uidDropPreflightArgv } from "../src/runtime/k8s/agent-uid-drop.ts";
import {
	agentContainerSecurityContext,
	type K8sPodConfig,
	resolveK8sPodConfig,
} from "../src/runtime/k8s/pod-spec.ts";

export const CANARY_POD_NAME = "warren-uid-drop-canary";
export const CANARY_LABEL_KEY = "warren.io/canary";
export const CANARY_LABEL_VALUE = "uid-drop";
export const DEFAULT_CANARY_NAMESPACE = "warren-runs";

/**
 * Build the canary pod: the run pod's agent-container security posture
 * (derived, not copied) around the setpriv preflight probe as the container
 * command. Pure.
 */
export function buildUidDropCanaryPod(opts: {
	image: string;
	namespace: string;
	config?: K8sPodConfig;
}): V1Pod {
	const config = opts.config ?? resolveK8sPodConfig({});
	const drop = config.agentUidDrop;
	if (drop === undefined) {
		throw new Error(
			"uid-drop-canary: the resolved config has the uid split disabled " +
				"(WARREN_K8S_AGENT_UID_DROP=0) — nothing to canary",
		);
	}
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: CANARY_POD_NAME,
			namespace: opts.namespace,
			labels: { [CANARY_LABEL_KEY]: CANARY_LABEL_VALUE },
		},
		spec: {
			restartPolicy: "Never",
			automountServiceAccountToken: false,
			securityContext: {
				runAsNonRoot: true,
				runAsUser: config.uid,
				runAsGroup: config.gid,
				fsGroup: config.gid,
				seccompProfile: { type: "RuntimeDefault" },
			},
			containers: [
				{
					name: "probe",
					image: opts.image,
					command: uidDropPreflightArgv(drop),
					// Small + explicit so Autopilot never injects surprise defaults;
					// the probe execs `true` and exits.
					resources: {
						requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "1Gi" },
						limits: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "1Gi" },
					},
					securityContext: agentContainerSecurityContext(config),
				},
			],
		},
	};
}

interface KubectlResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function kubectl(args: string[], stdin?: string): Promise<KubectlResult> {
	const proc = Bun.spawn(["kubectl", ...args], {
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

function parseArgs(argv: string[]): { image: string; namespace: string; timeoutSeconds: number } {
	let image: string | undefined;
	let namespace = DEFAULT_CANARY_NAMESPACE;
	let timeoutSeconds = 300;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`uid-drop-canary: ${arg} needs a value`);
			return v;
		};
		if (arg === "--image") image = next();
		else if (arg === "--namespace") namespace = next();
		else if (arg === "--timeout-seconds") timeoutSeconds = Number(next());
		else throw new Error(`uid-drop-canary: unknown argument ${arg}`);
	}
	if (image === undefined || image === "") {
		throw new Error("uid-drop-canary: --image <agent-image> is required");
	}
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
		throw new Error("uid-drop-canary: --timeout-seconds must be a positive number");
	}
	return { image, namespace, timeoutSeconds };
}

async function deleteCanary(namespace: string): Promise<void> {
	await kubectl([
		"delete",
		"pod",
		CANARY_POD_NAME,
		"-n",
		namespace,
		"--ignore-not-found",
		"--wait=false",
	]);
}

async function runCanary(args: {
	image: string;
	namespace: string;
	timeoutSeconds: number;
}): Promise<number> {
	const pod = buildUidDropCanaryPod({ image: args.image, namespace: args.namespace });
	// Idempotent: clear any leftover from an interrupted earlier gate run.
	await deleteCanary(args.namespace);
	const applied = await kubectl(["apply", "-f", "-"], JSON.stringify(pod));
	if (applied.exitCode !== 0) {
		console.error(`uid-drop-canary: kubectl apply failed\n${applied.stderr}`);
		return 1;
	}
	console.log(`uid-drop-canary: probing '${args.image}' in namespace '${args.namespace}'…`);
	const deadline = Date.now() + args.timeoutSeconds * 1000;
	let phase = "";
	while (Date.now() < deadline) {
		const res = await kubectl([
			"get",
			"pod",
			CANARY_POD_NAME,
			"-n",
			args.namespace,
			"-o",
			"jsonpath={.status.phase}",
		]);
		phase = res.stdout.trim();
		if (phase === "Succeeded" || phase === "Failed") break;
		await Bun.sleep(5000);
	}
	if (phase === "Succeeded") {
		console.log("uid-drop-canary: OK — the entrypoint/agent uid split works on this cluster");
		await deleteCanary(args.namespace);
		return 0;
	}
	console.error(
		`uid-drop-canary: FAILED — pod phase '${phase === "" ? "<unknown>" : phase}' ` +
			`(wanted Succeeded within ${args.timeoutSeconds}s). The uid split cannot ` +
			"privilege setpriv on this cluster; dispatched runs would die at the " +
			"preflight. See docs/RUNBOOK-K8S.md §4.2.",
	);
	const logs = await kubectl(["logs", CANARY_POD_NAME, "-n", args.namespace]);
	if (logs.stdout.trim() !== "" || logs.stderr.trim() !== "") {
		console.error(`--- canary pod logs ---\n${logs.stdout}${logs.stderr}`);
	}
	const describe = await kubectl(["describe", "pod", CANARY_POD_NAME, "-n", args.namespace]);
	console.error(`--- canary pod describe (tail) ---`);
	console.error(describe.stdout.split("\n").slice(-25).join("\n"));
	await deleteCanary(args.namespace);
	return 1;
}

if (import.meta.main) {
	runCanary(parseArgs(process.argv.slice(2)))
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
}
