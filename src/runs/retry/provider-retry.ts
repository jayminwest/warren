/**
 * Run-level provider-error retry (warren-339d).
 *
 * Observed 2026-08-07 on run_htwpffq19pmr (pi + openrouter/kimi-k3):
 * mid-implementation the provider stream dropped ("Network connection
 * lost."), the run terminalized `failed`/`provider_error` with zero
 * retry, and the workspace was destroyed with the agent's uncommitted
 * work. A single transient TCP reset cost the whole run. The pi harness
 * owns the in-stream reconnect, which warren cannot reach from the
 * control plane — so this module is the run-level fallback: when a run
 * reaps `failed`/`provider_error` and the provider's terminal message is
 * NETWORK-CLASS (connection reset/lost, timeout, 5xx), warren
 * auto-redispatches the run ONCE as a fresh run with the same
 * agent/project/prompt/seed, recording the lineage in both runs' event
 * streams.
 *
 * ## Transient vs durable
 *
 * {@link classifyProviderError} is the single discriminator. Only an
 * explicit TRANSIENT match retries; durable rejections (auth failure,
 * model-not-found, quota/credit, rate-limit, malformed request) and
 * anything unrecognized fail closed — a retry that can never succeed
 * just burns a second sandbox.
 *
 * ## The retry bound
 *
 * The redispatch stamps a `spawn.provider_retry` lineage event onto the
 * NEW run's stream, so any later failure can walk its own lineage back to
 * the root with no new schema. {@link MAX_PROVIDER_RETRIES} caps how many
 * of those stamps one lineage may hold. The run that reaches the cap gets
 * a `reap.provider_retry_exhausted` event instead of a successor, the
 * origin of every dispatched retry gets `reap.provider_retry_dispatched`
 * naming that successor, and a failure the classifier declines gets
 * `reap.provider_retry_skipped` carrying the verdict. The policy is
 * written down in `docs/design/provider-retry.md`.
 *
 * ## Wiring
 *
 * Like the seed-close safety net (`../reap/seed-close-lifecycle.ts`),
 * this is an observe-only Tier-1 lifecycle consumer: it subscribes to
 * `post_reap` and registers through the bus's boot-time registration
 * API. Plan-run children are EXCLUDED — the plan-run coordinator owns
 * child-level retry on `child_provider_error` (warren-6de9), and a
 * run-level retry underneath it would double-dispatch.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { EventRow, RunRow } from "../../db/schema.ts";
import type { Forge } from "../../forge/contract.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import type { SpawnFn as ProjectSpawnFn } from "../../projects/clone.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { RunEventBroker } from "../events.ts";
import { type LifecycleExtension, WARREN_EXT_PROTOCOL } from "../lifecycle-bus.ts";
import { spawnRun } from "../spawn/index.ts";
import type { SpawnLogger } from "../spawn/types.ts";
import type { BridgeRegistry } from "../stream/types.ts";
import { inheritedDispatchOverrides } from "./inherited-overrides.ts";

/** Event kinds this module stamps for lineage + observability. */
export const PROVIDER_RETRY_EVENTS = {
	/** Appended to the NEW run: it exists because `retriedFromRunId` failed transiently. */
	spawnRetry: "spawn.provider_retry",
	/** Appended to the FAILED run: names the successor run warren dispatched. */
	retryDispatched: "reap.provider_retry_dispatched",
	/** Appended to the FAILED run when the redispatch itself threw. */
	retryFailed: "reap.provider_retry_failed",
	/** Appended to the FAILED run whose lineage has spent the retry bound. */
	retryExhausted: "reap.provider_retry_exhausted",
	/** Appended to the FAILED run the classifier declined to retry. */
	retrySkipped: "reap.provider_retry_skipped",
} as const;

/**
 * How many auto-dispatched provider retries one lineage may hold
 * (warren-ac61). The origin run is not an attempt, so at 2 a transient
 * failure is redispatched twice before warren stops and says so.
 */
export const MAX_PROVIDER_RETRIES = 2;

/**
 * The retry verdict for a provider's terminal error message.
 *   - `transient` — network-class / upstream-class failure; worth one retry.
 *   - `durable`   — the provider rejected the request itself; a retry fails
 *                   the same way (auth, model, quota, rate-limit, 4xx).
 *   - `unknown`   — unrecognized; fails CLOSED (no retry).
 */
export type ProviderErrorClass = "transient" | "durable" | "unknown";

/**
 * Durable rejection patterns, checked FIRST — a message that names both a
 * network symptom and an auth/quota cause ("request failed: 401 ...") must
 * not retry. Case-insensitive substring/regex match against the provider's
 * terminal `errorMessage`.
 */
const DURABLE_PATTERNS: readonly RegExp[] = [
	// Auth / permission.
	/\b401\b/,
	/\b403\b/,
	/unauthorized/,
	/unauthenticated/,
	/authentication/,
	/invalid\s.*api[-_ ]?key/,
	/api[-_ ]?key/,
	/permission denied/,
	/forbidden/,
	// Model rejection.
	/model.*(not found|does not exist|not supported|invalid)/,
	/(not found|does not exist|invalid).*model/,
	/no such model/,
	/not_found_error/,
	/\b404\b/,
	// Quota / billing.
	/\b402\b/,
	/credit balance/,
	/quota/,
	/billing/,
	/insufficient/,
	// Rate limiting — a run-level redispatch has no backoff worth the name,
	// so an immediate retry would just hit the limiter again.
	/\b429\b/,
	/rate[ -]?limit/,
	/too many requests/,
	// Malformed request.
	/\b400\b/,
	/invalid_request/,
];

/** Transient network/upstream patterns — the only class that retries. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
	// Connection-class (the warren-339d case: "Network connection lost.").
	/network connection lost/,
	/connection (lost|reset|refused|closed|aborted|terminated)/,
	/econnreset/,
	/econnrefused/,
	/econnaborted/,
	/epipe/,
	/socket hang up/,
	/socket.*(closed|timeout)/,
	// Stream breaks can arrive after headers with no status/body left to parse.
	/stream ended/,
	/without finish_reason/,
	/premature close/,
	/\baborted\b/,
	/fetch failed/,
	/network error/,
	/\bnetwork\b/,
	/dns/,
	/eai_again/,
	// Timeout-class.
	/etimedout/,
	/esockettimedout/,
	/\btimeout\b/,
	/timed out/,
	// Upstream 5xx / overload (529 overloaded_error — cf. warren-e281).
	/\b5\d\d\b/,
	/internal server error/,
	/bad gateway/,
	/service unavailable/,
	/gateway timeout/,
	/overloaded/,
	/upstream/,
];

/**
 * Classify a provider's terminal error for retry. The structured
 * `httpStatus` (captured on the `reap.provider_error` payload by
 * warren-4001's enrichment) wins over prose parsing: a 5xx whose prose
 * never spells out the code must not fail closed as `unknown`
 * (warren-f8b2). Durable wins over transient when both match; no match
 * fails closed as `unknown`. Pure + defensive: any input (empty,
 * whitespace, non-string coerced by the caller, non-finite status)
 * classifies without throwing.
 */
export function classifyProviderError(
	message: string,
	httpStatus?: number | null,
	upstreamBody?: string | null,
): ProviderErrorClass {
	if (typeof httpStatus === "number" && Number.isFinite(httpStatus)) {
		if (httpStatus >= 500) return "transient";
		if (httpStatus >= 400 && httpStatus < 500) return "durable";
	}
	// Tier 2 (warren-eaa6): the structured upstream body carries the
	// provider's real rejection text even when the harness's surface
	// message is opaque (pi's `Provider returned error`). Classify it
	// before falling back to the free-prose message.
	if (typeof upstreamBody === "string" && upstreamBody.length > 0) {
		const bodyVerdict = classifyText(upstreamBody);
		if (bodyVerdict !== "unknown") return bodyVerdict;
	}
	return classifyText(message);
}

/** The prose tier: durable wins over transient; no match fails closed. */
function classifyText(text: string): ProviderErrorClass {
	const lower = text.toLowerCase();
	if (DURABLE_PATTERNS.some((p) => p.test(lower))) return "durable";
	if (TRANSIENT_PATTERNS.some((p) => p.test(lower))) return "transient";
	return "unknown";
}

/** Minimal structured-logger surface (pino-shaped), like the spawn flow's. */
export type ProviderRetryLogger = SpawnLogger;

export interface ProviderRetryLifecycleExtensionInput {
	readonly repos: Repos;
	/** Boot-resolved provider the redispatch runs through (same as `POST /runs`). */
	readonly runtimeProvider: RuntimeProvider;
	/** Bridge registry so the retried run's events stream into warren. */
	readonly bridges: BridgeRegistry;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: ProjectSpawnFn;
	/** Boot-resolved forge for the per-spawn credential mint (§4 — minted, never held). */
	readonly forge?: Forge;
	readonly warrenConfigs?: WarrenConfigCache;
	readonly runBranchPrefixDefault?: string;
	readonly seedsCli?: SeedsCliDeps;
	/** Boot-resolved IssueTracker (warren-5819) — threading seam for the retry spawn. */
	readonly issueTracker?: IssueTracker;
	readonly logger: ProviderRetryLogger;
	/** Broker so the lineage events reach live tailers too. */
	readonly broker?: RunEventBroker;
	/** Override the spawnRun seam (tests). Defaults to the live `spawnRun`. */
	readonly spawnRunFn?: typeof spawnRun;
	/** Injectable clock for the appended event timestamps (tests). */
	readonly now?: () => Date;
}

/**
 * Build the provider-retry observe-only lifecycle extension. Register it
 * via `bus.register(createProviderRetryLifecycleExtension({ … }))` at
 * boot (after the bridge registry exists — the redispatch attaches one).
 */
export function createProviderRetryLifecycleExtension(
	input: ProviderRetryLifecycleExtensionInput,
): LifecycleExtension {
	const now = input.now ?? (() => new Date());
	return {
		name: "provider-retry",
		protocol: WARREN_EXT_PROTOCOL,
		hooks: {
			post_reap: async (envelope) => {
				if (envelope.payload.outcome !== "failed") return;
				await maybeRetryProviderError(input, now, envelope.payload.runId);
			},
		},
	};
}

/**
 * The retry decision + redispatch. Every gate fails closed: any
 * uncertainty (missing row, missing message, unrecognized error) means
 * NO retry, and a thrown redispatch is logged + recorded as an event
 * rather than propagated (the bus would swallow it anyway — this way the
 * failure is visible on the run's stream).
 */
async function maybeRetryProviderError(
	input: ProviderRetryLifecycleExtensionInput,
	now: () => Date,
	runId: string,
): Promise<void> {
	const run = await input.repos.runs.get(runId);
	if (run === null) return;
	if (run.failureReason !== "provider_error") return;
	const projectId = run.projectId;
	if (projectId === null) return;
	// Plan-run children retry at the coordinator level (warren-6de9); a
	// run-level retry underneath would double-dispatch the child.
	if (run.trigger === "plan-run" || run.trigger === "auto_plan_run") return;

	const events = await input.repos.events.listByRun(runId);
	const emit = makeRunEventEmitter(input, now);
	// The missing-data gate comes first and stays silent. A run with no
	// `reap.provider_error` message never reached the classifier, so neither a
	// verdict nor an exhaustion verdict would describe anything that happened
	// (docs/design/provider-retry.md section 3). It is also the cheaper of the
	// two: the signal is already in `events`, the bound reads chain rows.
	const signal = lastProviderErrorSignal(events);
	if (signal === null) return;
	// The bound: a lineage that has spent its attempts stops here, on the
	// run that reached the cap, rather than returning bare.
	const attempts = await countProviderRetries(input.repos, run, events);
	if (attempts >= MAX_PROVIDER_RETRIES) {
		input.logger.info(
			{ runId, attempts, maxAttempts: MAX_PROVIDER_RETRIES },
			"provider-retry.exhausted: the lineage has spent its retry bound",
		);
		await emit(runId, PROVIDER_RETRY_EVENTS.retryExhausted, {
			attempts,
			maxAttempts: MAX_PROVIDER_RETRIES,
		});
		return;
	}
	const verdict = classifyProviderError(signal.message, signal.httpStatus, signal.upstreamBody);
	if (verdict !== "transient") {
		input.logger.info(
			{ runId, verdict, providerError: signal.message },
			"provider-retry.skipped: error is not transient",
		);
		await emit(runId, PROVIDER_RETRY_EVENTS.retrySkipped, {
			verdict,
			providerError: signal.message,
		});
		return;
	}

	await dispatchProviderRetry(input, now, { ...run, projectId }, signal.message);
}

/**
 * How many provider retries this lineage has already spent, counted from
 * the run that just failed backwards toward the root. A run carrying the
 * `spawn.provider_retry` stamp was dispatched as one; every other run in
 * the chain adds nothing, including an infra-lost retry that interrupted
 * it. Counting `retryOf` hops instead would over-count, because
 * `./infra-lost-retry.ts` writes that column too.
 *
 * Only the two retry dispatchers write `retryOf`, so the chain is the
 * retry depth and nothing else. `parentRunId` is followed only from a run
 * that carries the stamp, which is the pre-warren-eaa6 provider-retry row
 * shape, so a plain `continue` clone is never walked. The walk stops at
 * the cap, so it reads at most {@link MAX_PROVIDER_RETRIES} chain rows.
 */
async function countProviderRetries(
	repos: Repos,
	failed: Pick<RunRow, "id" | "retryOf" | "parentRunId">,
	failedEvents: readonly EventRow[],
): Promise<number> {
	let attempts = 0;
	let current: Pick<RunRow, "id" | "retryOf" | "parentRunId"> | null = failed;
	let events: readonly EventRow[] = failedEvents;
	const seen = new Set<string>([failed.id]);
	while (current !== null && attempts < MAX_PROVIDER_RETRIES) {
		const stamped = events.some((e) => e.kind === PROVIDER_RETRY_EVENTS.spawnRetry);
		if (stamped) attempts += 1;
		const parentId: string | null = current.retryOf ?? (stamped ? current.parentRunId : null);
		if (parentId === null || seen.has(parentId)) break;
		seen.add(parentId);
		current = await repos.runs.get(parentId);
		events = current === null ? [] : await repos.events.listByRun(parentId);
	}
	return attempts;
}

/**
 * The redispatch itself: mint the per-spawn credential, spawn the
 * successor (`replicate` lineage off the failed run), attach its bridge,
 * and stamp the lineage events on both streams. A thrown redispatch is
 * logged + recorded as a `reap.provider_retry_failed` event rather than
 * propagated — the bus would swallow it anyway, and this way the failure
 * is visible on the run's stream.
 */
async function dispatchProviderRetry(
	input: ProviderRetryLifecycleExtensionInput,
	now: () => Date,
	run: {
		readonly id: string;
		readonly agentName: string;
		readonly projectId: string;
		readonly prompt: string;
		readonly trigger: string;
		readonly seedId: string | null;
		readonly mode: "batch";
		/** Frozen at the original dispatch; the retry's overrides are read back off it. */
		readonly renderedAgentJson: unknown;
	},
	message: string,
): Promise<void> {
	const emit = makeRunEventEmitter(input, now);
	try {
		const project = await input.repos.projects.get(run.projectId);
		const gitCredential =
			input.forge !== undefined && project !== null
				? await mintGitCredential(input.forge, project.gitUrl)
				: undefined;
		const spawnRunFn = input.spawnRunFn ?? spawnRun;
		const result = await spawnRunFn({
			repos: input.repos,
			runtimeProvider: input.runtimeProvider,
			agentName: run.agentName,
			projectId: run.projectId,
			prompt: run.prompt,
			// trigger is inherited from the original (lossy for provenance) —
			// dispatchOrigin is the explicit "this row is a provider retry"
			// stamp (warren-9ce3).
			trigger: run.trigger,
			dispatchOrigin: "retry_provider",
			...(run.seedId !== null ? { seedId: run.seedId } : {}),
			mode: run.mode,
			// warren-0d80: the provider, model and cap the original run actually
			// resolved sit folded on its frozen frontmatter. Without them the
			// retry re-resolves off the agent and the project defaults, so an
			// operator-selected model silently swaps mid-lineage.
			...inheritedDispatchOverrides(run.renderedAgentJson),
			// Lineage on the row (warren-e96f `replicate` semantics): a fresh
			// re-dispatch of the failed run's config off the project default
			// branch, independent of whatever the failed run did. The event
			// markers below carry the retry-specific provenance.
			parentRunId: run.id,
			cloneKind: "replicate",
			// retryOf back-link (warren-eaa6/warren-58ff): retry projections
			// and the dispatch-context log (warren-d6ca) read `runs.retry_of`
			// uniformly, independent of the event-marker lineage.
			retryOf: run.id,
			projectsConfig: input.projectsConfig,
			projectSpawn: input.projectSpawn,
			gitCredential,
			...(input.warrenConfigs !== undefined ? { warrenConfigs: input.warrenConfigs } : {}),
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
			...(input.seedsCli !== undefined ? { seedsCli: input.seedsCli } : {}),
			...(input.issueTracker !== undefined ? { issueTracker: input.issueTracker } : {}),
			logger: input.logger,
			now,
		});
		input.bridges.start(result.run.id, result.sandboxRun.id, result.sandbox.id, result.run.mode);
		// Lineage on BOTH streams: the successor names its origin (this is
		// also the single-retry bound marker), the origin names its successor.
		await emit(result.run.id, PROVIDER_RETRY_EVENTS.spawnRetry, {
			retriedFromRunId: run.id,
			providerError: message,
		});
		await emit(run.id, PROVIDER_RETRY_EVENTS.retryDispatched, {
			newRunId: result.run.id,
			providerError: message,
		});
		input.logger.info(
			{ runId: run.id, newRunId: result.run.id, providerError: message },
			"provider-retry.dispatched",
		);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		input.logger.error({ runId: run.id, reason }, "provider-retry.failed");
		await emit(run.id, PROVIDER_RETRY_EVENTS.retryFailed, { error: reason }).catch(() => {});
	}
}

/** The structured signal off the last `reap.provider_error` event, if any. */
interface ProviderErrorEventSignal {
	readonly message: string;
	/** Structured status captured by warren-4001's enrichment, else `null`. */
	readonly httpStatus: number | null;
	/** Structured upstream body captured by warren-4001's enrichment, else `null`. */
	readonly upstreamBody: string | null;
}

function lastProviderErrorSignal(events: readonly EventRow[]): ProviderErrorEventSignal | null {
	let signal: ProviderErrorEventSignal | null = null;
	for (const event of events) {
		if (event.kind !== "reap.provider_error") continue;
		const payload = event.payloadJson as {
			message?: unknown;
			httpStatus?: unknown;
			upstreamBody?: unknown;
		} | null;
		if (payload !== null && typeof payload.message === "string" && payload.message.length > 0) {
			signal = {
				message: payload.message,
				httpStatus: typeof payload.httpStatus === "number" ? payload.httpStatus : null,
				upstreamBody: typeof payload.upstreamBody === "string" ? payload.upstreamBody : null,
			};
		}
	}
	return signal;
}

/**
 * An `emit(runId, kind, payload)` closure appending a run event with a
 * fresh monotonic seq and publishing it to the broker (best-effort) —
 * same shape as the seed-close subscriber's emitter.
 */
function makeRunEventEmitter(
	input: ProviderRetryLifecycleExtensionInput,
	now: () => Date,
): (runId: string, kind: string, payload: unknown) => Promise<EventRow> {
	return async (runId, kind, payload) => {
		const maxSeq = (await input.repos.events.maxSeqForRun(runId)) ?? 0;
		const row = await input.repos.events.append({
			runId,
			sandboxEventSeq: maxSeq + 1,
			ts: now().toISOString(),
			kind,
			stream: "system",
			payload,
		});
		input.broker?.publish(runId, row);
		return row;
	};
}
