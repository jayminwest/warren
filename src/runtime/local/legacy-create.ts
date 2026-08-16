/**
 * LEGACY burrow-backed `LocalProvider.create` (pre-warren-413d). Kept for the
 * transition window: tests and the `warren run` local backend that still hold
 * a burrow client drive this path. Production boot no longer wires a client
 * into the provider, so the daemon is off the SPAWN path there — this module
 * leaves with warren-9a26/warren-ea0a (daemon teardown).
 *
 * Collapses burrow's two-call provision-then-dispatch ritual (`burrowsUp` +
 * `http.runs.create`) into the single seam method §6.1 mandates, reproducing
 * the old `src/runs/spawn/dispatch.ts` burrow-touching behavior faithfully —
 * argument construction, transport-error mapping, and cleanup-on-partial-
 * failure (best-effort burrow destroy + rethrow).
 */

import { type BurrowClient, withTransportMapping } from "../../burrow-client/index.ts";
import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import { loopbackApiUrl } from "../../runs/spawn/callback-env.ts";
import type { RunHandle, RunSpec } from "../contract.ts";
import { RuntimeProviderError } from "../errors.ts";

/**
 * Route Bun's install cache outside the workspace so `git add .` never sweeps
 * it. Provider-owned filesystem-layout env (§6.1).
 */
const BUN_INSTALL_CACHE_DIR = "/tmp/bun-install-cache";

/** Provision a burrow and dispatch a run onto it — the legacy two-call body. */
export async function legacyCreate(
	client: BurrowClient,
	spec: RunSpec,
	serverEnv: EnvLike | undefined,
): Promise<RunHandle> {
	const env = composeLegacySandboxEnv(spec.env, serverEnv);
	const burrow = await withTransportMapping(client.config, () =>
		client.burrowsUp(buildBurrowsUpInput(spec, env)),
	);
	let burrowRun: Awaited<ReturnType<BurrowClient["http"]["runs"]["create"]>>;
	try {
		burrowRun = await withTransportMapping(client.config, () =>
			client.http.runs.create(buildRunsCreateInput(spec, burrow.id)),
		);
	} catch (err) {
		await bestEffortDestroy(client, burrow.id);
		throw err;
	}
	return { runId: spec.runId, sandboxId: burrow.id, providerRunId: burrowRun.id };
}

/**
 * Merge the DOMAIN env with the provider's OWN plumbing. Provider keys are
 * applied last so they win — the domain must not set them. The callback URL
 * rides only when the domain supplied a `WARREN_API_TOKEN`.
 */
function composeLegacySandboxEnv(
	domainEnv: Record<string, string>,
	serverEnv: EnvLike | undefined,
): Record<string, string> {
	const env: Record<string, string> = { ...domainEnv, BUN_INSTALL_CACHE_DIR };
	const token = domainEnv.WARREN_API_TOKEN;
	if (token !== undefined && token !== "") {
		const url = loopbackApiUrl(serverEnv ?? process.env);
		if (url !== null) env.WARREN_API_URL = url;
	}
	return env;
}

/**
 * Map the neutral `RunSpec` onto burrow's `POST /burrows` body. An absent
 * `hostClonePathHint` is a hard error — burrow cannot provision without the
 * host clone to fork the worktree from.
 */
function buildBurrowsUpInput(
	spec: RunSpec,
	env: Record<string, string>,
): Parameters<BurrowClient["burrowsUp"]>[0] {
	if (spec.hostClonePathHint === undefined || spec.hostClonePathHint === "") {
		throw new RuntimeProviderError(
			"LocalProvider.create requires spec.hostClonePathHint (the host clone projectRoot)",
			{
				recoveryHint:
					"the burrow backend materializes the workspace as a git worktree off the host " +
					"clone; supply hostClonePathHint on the RunSpec (K8s ignores it)",
			},
		);
	}
	return {
		projectRoot: spec.hostClonePathHint,
		originUrl: spec.originUrl,
		agents: [spec.runtimeId],
		branch: spec.branch,
		baseBranch: spec.baseBranch,
		network: spec.network,
		...(spec.seedFiles.length > 0 ? { seed: { files: spec.seedFiles.map(toWorkspaceFile) } } : {}),
		env,
	};
}

type WorkspaceFile = {
	path: string;
	contents: string;
	encoding?: "utf-8" | "base64";
	mode?: number;
};

/** Narrow a `RunSpec` seed file onto burrow's `HttpWorkspaceFile`. */
function toWorkspaceFile(f: RunSpec["seedFiles"][number]): WorkspaceFile {
	return {
		path: f.path,
		contents: f.contents,
		...(f.encoding !== undefined ? { encoding: f.encoding as "utf-8" | "base64" } : {}),
		...(f.mode !== undefined ? { mode: f.mode } : {}),
	};
}

/** Map the neutral `RunSpec` onto burrow's `POST /burrows/:id/runs` body. */
function buildRunsCreateInput(
	spec: RunSpec,
	burrowId: string,
): Parameters<BurrowClient["http"]["runs"]["create"]>[0] {
	return {
		burrowId,
		agentId: spec.runtimeId,
		prompt: spec.prompt,
		...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
	};
}

/**
 * Best-effort destroy of a provisioned burrow after a failed dispatch.
 * Swallowed: a cleanup failure must never mask the original dispatch error.
 */
async function bestEffortDestroy(client: BurrowClient, burrowId: string): Promise<void> {
	try {
		await withTransportMapping(client.config, () =>
			client.http.burrows.destroy(burrowId, { archive: false }),
		);
	} catch {
		// swallowed by contract — see doc comment.
	}
}
