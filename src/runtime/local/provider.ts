/**
 * `LocalProvider` — the burrow-backed `RuntimeProvider` (contract in
 * `../contract.ts`). It is the self-host / single-container backend: it wraps
 * warren's existing `src/burrow-client/` facade so today's behavior flows
 * through the seam unchanged (design doc §7, plan §6 checkpoint 2).
 *
 * `create()` (pl-829f step 8, phase CONTRACT) is the first real body: it
 * collapses burrow's two-call provision-then-dispatch ritual
 * (`burrowsUp` + `http.runs.create`) into the single seam method §6.1
 * mandates, reproducing today's `src/runs/spawn/dispatch.ts` burrow-touching
 * behavior faithfully — argument construction, transport-error mapping, and
 * cleanup-on-partial-failure (best-effort burrow destroy + rethrow). The
 * remaining methods are still deliberate stubs that throw
 * `RuntimeNotImplementedError`; later steps of the LocalProvider checkpoint
 * fill each one.
 *
 * The dependency is taken as a FACTORY (`() => BurrowClientPool`) rather than a
 * live pool: at boot the pool already exists so wiring is `() => pool`, but the
 * lazy shape keeps the provider — and the registry that builds it — testable
 * without standing up a pool at construction time.
 */

import {
	type BurrowClient,
	type BurrowClientPool,
	LOCAL_WORKER_NAME,
	withTransportMapping,
} from "../../burrow-client/index.ts";
import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import { loopbackApiUrl } from "../../runs/spawn/callback-env.ts";
import type {
	FinalizeIntent,
	FinalizeResult,
	Message,
	NormalizedEvent,
	OutboundMessage,
	RunHandle,
	RunSpec,
	RunStatus,
	RuntimeCapabilities,
	RuntimeProvider,
	StreamOpts,
	TeardownResult,
} from "../contract.ts";
import { RuntimeNotImplementedError, RuntimeProviderError } from "../errors.ts";
import { sendLocalMessage } from "./send-message.ts";
import { localRunStatus } from "./status.ts";
import { streamLocalEvents } from "./stream.ts";

/** Dependencies the burrow-backed provider methods wrap. */
export interface LocalProviderDeps {
	/**
	 * Lazily supplies the burrow-client pool the real methods adapt (placement
	 * is deleted at the seam — design §3 — so `create()` resolves the sole
	 * single-container worker, not a project-affinity placement). A factory so
	 * the provider can be built before — or without — a live pool.
	 */
	readonly burrowClientPool: () => BurrowClientPool;
	/**
	 * Server-process env the provider reads to compute its OWN plumbing — today
	 * just the loopback callback URL (`WARREN_API_URL`, §6.3). Defaults to
	 * `process.env`. The domain must NOT set `WARREN_API_URL`; the provider
	 * owns it because `http://localhost:PORT` is a co-tenancy assumption a K8s
	 * backend would replace with Service DNS.
	 */
	readonly serverEnv?: EnvLike;
}

/**
 * The burrow feature set. LocalProvider is the reference backend, so every
 * capability is at its strongest: all booleans `true` and the per-domain
 * network allowlist (design doc §5 — the K8s v1 backend degrades several of
 * these, e.g. `networkPolicy: "coarse"`). Frozen so the domain can read but
 * never mutate a provider's advertised capabilities.
 */
export const LOCAL_PROVIDER_CAPABILITIES: RuntimeCapabilities = Object.freeze({
	previewPorts: true,
	networkPolicy: "domain-allowlist",
	longLived: true,
	midRunSteering: true,
	enforcedResourceLimits: true,
	workspaceArchive: true,
});

/**
 * Route Bun's install cache outside the workspace so `git add .` never sweeps
 * it. Provider-owned filesystem-layout env (§6.1) — mirrors the constant
 * `src/runs/spawn/dispatch.ts` injects today so behavior is unchanged.
 */
const BUN_INSTALL_CACHE_DIR = "/tmp/bun-install-cache";

/** Raise the standard stub error, naming the method and the step that fills it. */
function notImplemented(method: string): never {
	throw new RuntimeNotImplementedError(`LocalProvider.${method}() is not implemented yet`, {
		recoveryHint:
			"Filled in a later step of the LocalProvider checkpoint (pl-829f, phase CONTRACT) — " +
			"the method wraps src/burrow-client/. This shell only fixes the contract shape.",
	});
}

export class LocalProvider implements RuntimeProvider {
	readonly capabilities: RuntimeCapabilities = LOCAL_PROVIDER_CAPABILITIES;

	constructor(private readonly deps: LocalProviderDeps) {}

	/**
	 * Provision a burrow and dispatch a run onto it — burrow's two calls behind
	 * the one seam method (§6.1). Faithful to `spawnRun`'s burrow-touching half
	 * (`provisionBurrow` → `dispatchRun` in `src/runs/spawn/dispatch.ts`):
	 *
	 *   1. `burrowsUp` (POST /burrows) with the workspace inputs + seed drops +
	 *      the merged sandbox env, wrapped in `withTransportMapping` so a dead
	 *      socket surfaces as `BurrowUnreachableError` rather than a raw fetch
	 *      reject.
	 *   2. `http.runs.create` (POST /burrows/:id/runs) with the pre-composed
	 *      prompt + metadata, same transport mapping.
	 *
	 * On a partial failure — step 1 succeeds, step 2 throws — the provisioned
	 * burrow is best-effort destroyed (mirroring the burrow half of
	 * `rollback()`) and the ORIGINAL error is rethrown. The warren-row unwind
	 * (`persistSpawnFailure`: events + `runs.finalize`) is DOMAIN state the
	 * provider does not own and does not touch — that half stays in the domain
	 * call-site (step 13).
	 */
	async create(spec: RunSpec): Promise<RunHandle> {
		const client = this.resolveClient();
		const env = this.composeSandboxEnv(spec.env);
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
	 * Resolve the single burrow client this run dispatches against. Placement /
	 * worker routing is deleted at the seam (design §3) — the single-container
	 * LocalProvider has exactly one burrow worker, so there is nothing to place.
	 * Prefer the synthetic `local` worker `BurrowClientPool.fromEnv` registers;
	 * fall back to the sole worker when the pool was booted with a single
	 * differently-named entry.
	 *
	 * SEAM SIGNAL (step 13): `RunSpec` carries no `projectId`, so a multi-worker
	 * pool has no project-affinity answer here — a pool with >1 worker throws.
	 * That is intentional: multi-worker burrow placement is being retired with
	 * the K8s migration (plan §5.C); it is not smuggled back across the seam.
	 */
	private resolveClient(): BurrowClient {
		const pool = this.deps.burrowClientPool();
		if (pool.has(LOCAL_WORKER_NAME)) return pool.get(LOCAL_WORKER_NAME);
		const entries = pool.entries();
		const only = entries.length === 1 ? entries[0] : undefined;
		if (only !== undefined) return only.client;
		throw new RuntimeProviderError(
			`LocalProvider cannot resolve a single burrow worker (pool has ${entries.length})`,
			{
				recoveryHint:
					"the single-container backend expects one worker (the synthetic 'local'); " +
					"multi-worker placement is retired with the K8s migration",
			},
		);
	}

	/**
	 * Merge the DOMAIN env (`spec.env`: PLOT_ID/PLOT_ACTOR, WARREN_QUALITY_GATE,
	 * WARREN_API_TOKEN — coordination + secrets) with the provider's OWN
	 * plumbing (`BUN_INSTALL_CACHE_DIR` + the computed `WARREN_API_URL` callback,
	 * §6.1/§6.3). Provider keys are applied last so they win — the domain must
	 * not set them, and this guarantees it can't.
	 *
	 * Faithful to `composeRunEnv` + `injectWarrenCallbackEnv` in `dispatch.ts`:
	 * the callback URL is advertised only when the domain supplied a
	 * `WARREN_API_TOKEN` (no token ⇒ the sandbox has no credential to call back
	 * with, so the URL would be dead). The domain owns the token decision; the
	 * provider owns URL derivation.
	 */
	private composeSandboxEnv(domainEnv: Record<string, string>): Record<string, string> {
		const env: Record<string, string> = { ...domainEnv, BUN_INSTALL_CACHE_DIR };
		const token = domainEnv.WARREN_API_TOKEN;
		if (token !== undefined && token !== "") {
			const url = loopbackApiUrl(this.deps.serverEnv ?? process.env);
			if (url !== null) env.WARREN_API_URL = url;
		}
		return env;
	}

	/**
	 * Wrap burrow's `GET /runs/:id/stream` NDJSON stream (the same endpoint
	 * `src/runs/stream/bridge.ts` consumes) as the seam's ordered, resumable,
	 * lossless `NormalizedEvent` stream. Resume rides `opts.sinceSeq` (client-side
	 * dedup — burrow has no server-side cursor), abort rides the async-iterator
	 * protocol. See `./stream.ts` for the full contract mapping.
	 */
	streamEvents(handle: RunHandle, opts?: StreamOpts): AsyncIterable<NormalizedEvent> {
		return streamLocalEvents(this.resolveClient(), handle.providerRunId, opts);
	}

	/**
	 * Wrap burrow's `runs.get` into the out-of-band `RunStatus` reconcile
	 * snapshot. NEVER throws on a missing run — a burrow 404 returns
	 * `exists:false` + `terminalReason:"lost"` (§6.7). Recovers the `oom_killed`
	 * signal burrow stamps onto a failed run's `errorMessage` (§6.5). See
	 * `./status.ts` for the full burrow-state → phase/terminalReason table.
	 */
	status(handle: RunHandle): Promise<RunStatus> {
		return localRunStatus(this.resolveClient(), handle);
	}

	/**
	 * Enqueue a steering message onto the run's burrow inbox — burrow's
	 * `POST /burrows/:id/inbox`, the same call `src/runs/steer.ts` makes today
	 * (the domain call-site is untouched until step 13). Preserves burrow's
	 * priority-desc-then-FIFO claim ordering and unread→delivered→failed
	 * lifecycle by inventing no defaults: `priority`/`fromActor` ride only when
	 * supplied, exactly as steer sends them. See `./send-message.ts` for the
	 * full param + `Message`-row mapping.
	 */
	sendMessage(handle: RunHandle, msg: OutboundMessage): Promise<Message> {
		return sendLocalMessage(this.resolveClient(), handle, msg);
	}

	cancel(_handle: RunHandle, _reason?: string): Promise<void> {
		return notImplemented("cancel");
	}

	finalize(_handle: RunHandle, _intent: FinalizeIntent): Promise<FinalizeResult> {
		return notImplemented("finalize");
	}

	terminate(_handle: RunHandle): Promise<TeardownResult> {
		return notImplemented("terminate");
	}
}

/**
 * Map the neutral `RunSpec` onto burrow's `POST /burrows` body — the same
 * fields `provisionBurrow` builds today.
 *
 * Field map (RunSpec → burrowsUp):
 *   - `hostClonePathHint` → `projectRoot` (REQUIRED by burrow; LocalProvider
 *     forks the workspace as a git worktree off this host clone). RunSpec
 *     models it as an optional hint because K8s ignores it — but the burrow
 *     backend cannot provision without it, so an absent hint is a hard error.
 *     SEAM SIGNAL: `projectRoot` is a host path with no provider-neutral home;
 *     it survives only as this optional hint.
 *   - `originUrl` → `originUrl`.
 *   - `runtimeId` → `agents: [runtimeId]` (burrow resolves the toolchain image
 *     from its runtime registry; the domain pre-resolves the runtime id).
 *   - `branch`   → `branch` (the domain composes `${prefix}/${runId}`).
 *   - `network`  → `network` (RunSpec's `"none"|"restricted"|"open"` IS burrow's
 *     `NetworkPolicy` verbatim). Always sent: the domain resolves a concrete
 *     intent, so the "undefined ⇒ burrow default" omission `dispatch.ts` does
 *     today moves to the domain (step 13).
 *   - `seedFiles` → `seed.files` (the `.canopy/.mulch/.seeds/.pi` drops).
 *   - `env`      → `env` (already merged with provider plumbing by the caller).
 *
 * UNMAPPED RunSpec fields (documented seam signal — no burrow-request home in
 * the LocalProvider path today):
 *   - `baseBranch`: PROMOTED for K8s's init container, but `dispatch.ts` does
 *     NOT pass it — burrow resolves it internally (`default_branch ?? "main"`)
 *     and the host-clone refresh (a domain step outside `create()`) positions
 *     the fork base. Forwarding it here would CHANGE today's behavior, so we
 *     deliberately omit it and keep the LocalProvider byte-faithful.
 *   - `resources` / `timeoutMs`: no field on `POST /burrows`; `dispatch.ts`
 *     never sends them. Carried for the K8s pod securityContext/limits.
 *   - `mode`: domain state (selects long-lived vs batch handling) — never a
 *     burrow-request field on this dispatch path.
 *   - `runId`: warren identity; used only for the returned `RunHandle`.
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

/**
 * Narrow a `RunSpec` seed file onto burrow's `HttpWorkspaceFile`. RunSpec keeps
 * `encoding` an open `string` (provider-neutral); the domain only ever emits
 * `"utf-8"`/`"base64"`, so we forward it verbatim as burrow's encoding union.
 */
function toWorkspaceFile(f: RunSpec["seedFiles"][number]): WorkspaceFile {
	return {
		path: f.path,
		contents: f.contents,
		...(f.encoding !== undefined ? { encoding: f.encoding as "utf-8" | "base64" } : {}),
		...(f.mode !== undefined ? { mode: f.mode } : {}),
	};
}

/**
 * Map the neutral `RunSpec` onto burrow's `POST /burrows/:id/runs` body — the
 * same fields `dispatchRun` builds today.
 *
 * Field map (RunSpec → runs.create):
 *   - `runtimeId` → `agentId` (dispatch onto the burrow runtime id, not the
 *     canopy agent name).
 *   - `prompt`    → `prompt` (the domain already prepended the system section;
 *     the provider does NOT re-compose it).
 *   - `metadata`  → `metadata` (the domain already folded in `{ frontmatter }`).
 */
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
 * Best-effort destroy of a provisioned burrow after a failed dispatch — the
 * burrow half of `src/runs/spawn/rollback.ts`. Transport-mapped and swallowed:
 * a cleanup failure must never mask the original dispatch error the caller is
 * about to see rethrown (the operator can list stranded burrows via burrow's
 * own CLI/UI).
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
