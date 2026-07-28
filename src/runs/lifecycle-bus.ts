/**
 * Tier-1 observation event bus (warren-bb60, pl-3a79 step 16;
 * PHILOSOPHY "Extension tiers" + operating rule 6).
 *
 * This is the observe-only lifecycle seam layered beside warren's
 * per-run event fan-out (`./events.ts`, {@link RunEventBroker}). Where
 * the broker fans a run's *event rows* out to live tailers, this bus
 * fans the *run lifecycle* — dispatched → started → each emitted event
 * → pre/post reap → branch pushed — out to boot-wired consumers
 * (detectors, mirrors, the healer) so first-party features are
 * expressible as extensions rather than bespoke `ServerDeps` fields
 * (rule 2, rule 3).
 *
 * ## Observe-only (rule 6)
 *
 * Every hook is READ-ONLY. A subscriber receives a deep-frozen
 * {@link LifecycleEnvelope}; its return value is ignored and any thrown
 * error is caught and routed to the bus `onError` sink — a subscriber
 * can neither veto a dispatch, mutate a payload, nor stall the run
 * loop. Mutating / participate hooks (pre-dispatch veto, etc.) are
 * deliberately absent until a real extension needs them. Payloads are
 * plain provider-neutral DTOs; nothing here reaches across the
 * runtime seam.
 *
 * ## Versioned from day one (rule 6, Terraform-style)
 *
 * Every payload is stamped with {@link WARREN_EXT_PROTOCOL}
 * (`warren-ext/v1`). Registration is a handshake: an extension declares
 * the protocol it was built against and the bus refuses a mismatch, so
 * a future `warren-ext/v2` can ship a compat shim rather than silently
 * feeding v2 envelopes to a v1 consumer.
 *
 * ## Foundation for the follow-ups
 *
 * warren-4e74 re-homes the healer as the first proof consumer and
 * warren-df3e evicts the mulch/seeds mirrors from `finalize()` onto the
 * bus. Both register through {@link LifecycleBus.register}; neither adds
 * a `ServerDeps` field. The emit call-sites along the run lifecycle are
 * the seam those issues subscribe to — see the typed `emit*` helpers.
 */

/** The wire protocol every lifecycle payload is stamped with. */
export const WARREN_EXT_PROTOCOL = "warren-ext/v1";
export type WarrenExtProtocol = typeof WARREN_EXT_PROTOCOL;

/**
 * The observe-only lifecycle hook taxonomy (PHILOSOPHY rule 6). Ordered
 * along a run's life: dispatched → started → each emitted event →
 * pre-reap → post-reap → branch pushed. No mutating hooks yet.
 */
export const LIFECYCLE_HOOKS = [
	"run_dispatched",
	"run_started",
	"event_emitted",
	"pre_reap",
	"post_reap",
	"branch_pushed",
] as const;
export type LifecycleHook = (typeof LIFECYCLE_HOOKS)[number];

/** The run terminal outcome a reap carries, provider-neutral. */
export type LifecycleOutcome = "succeeded" | "failed" | "cancelled";

/**
 * `run_dispatched` — the runtime has a dispatched run: the warren row
 * exists and `provider.create` returned a handle. Fired once per run
 * after `spawnRun` writes back the correlation ids.
 */
export interface RunDispatchedPayload {
	readonly runId: string;
	readonly projectId: string;
	readonly agentName: string;
	readonly branch: string;
	readonly trigger: string;
	/** Provider-neutral sandbox correlation id (burrow id / pod name). */
	readonly sandboxId: string;
	/** Provider-neutral run correlation id (burrow run id). */
	readonly providerRunId: string;
}

/**
 * `run_started` — the run left `queued` for `running` (first event
 * observed on the bridge, or a state poll flip).
 */
export interface RunStartedPayload {
	readonly runId: string;
}

/**
 * `event_emitted` — one run-event row landed in the events table and
 * was published to the broker. This is the lifecycle mirror of
 * {@link RunEventBroker.publish}; the payload is the minimal
 * provider-neutral projection of an `EventRow`.
 */
export interface EventEmittedPayload {
	readonly runId: string;
	readonly seq: number;
	readonly kind: string;
	readonly stream: string;
}

/**
 * `pre_reap` — reap is about to run for a terminated run, before the
 * finalize pipeline touches the workspace.
 */
export interface PreReapPayload {
	readonly runId: string;
	readonly projectId: string;
	readonly outcome: LifecycleOutcome;
}

/**
 * `post_reap` — the reap pipeline finished. Carries the summary
 * downstream consumers key off (mirror counts, push result). This is
 * the hook warren-df3e's evicted mulch/seeds mirrors subscribe to.
 */
export interface PostReapPayload {
	readonly runId: string;
	readonly projectId: string;
	readonly outcome: LifecycleOutcome;
	readonly branchPushed: boolean;
	readonly commitsAhead: number | null;
	readonly prUrl: string | null;
}

/**
 * `branch_pushed` — the run's workspace branch reached origin. Fired
 * only when finalize actually pushed commits.
 */
export interface BranchPushedPayload {
	readonly runId: string;
	readonly branch: string;
	readonly baseBranch: string | null;
	readonly commitsAhead: number | null;
}

/** Map each hook to its payload shape. */
export interface LifecyclePayloads {
	readonly run_dispatched: RunDispatchedPayload;
	readonly run_started: RunStartedPayload;
	readonly event_emitted: EventEmittedPayload;
	readonly pre_reap: PreReapPayload;
	readonly post_reap: PostReapPayload;
	readonly branch_pushed: BranchPushedPayload;
}

/**
 * The versioned envelope a subscriber receives. `protocol` is stamped
 * on every payload (negotiated at handshake); `at` is an ISO timestamp
 * the bus stamps at emit time.
 */
export interface LifecycleEnvelope<H extends LifecycleHook = LifecycleHook> {
	readonly protocol: WarrenExtProtocol;
	readonly hook: H;
	readonly runId: string;
	readonly at: string;
	readonly payload: LifecyclePayloads[H];
}

/** An observe-only handler. Return value is ignored; may be async. */
export type LifecycleHandler<H extends LifecycleHook> = (
	envelope: LifecycleEnvelope<H>,
) => void | Promise<void>;

/**
 * A boot-wired consumer. `protocol` is the handshake: it must equal
 * {@link WARREN_EXT_PROTOCOL} or registration throws. `hooks` is a
 * partial map — an extension subscribes to exactly the hooks it names,
 * and each hook it names is its declared capability.
 */
export interface LifecycleExtension {
	readonly name: string;
	readonly protocol: WarrenExtProtocol;
	readonly hooks: Partial<{ [H in LifecycleHook]: LifecycleHandler<H> }>;
}

/** Handle returned by {@link LifecycleBus.register}; call to detach. */
export interface LifecycleRegistration {
	readonly name: string;
	unregister(): void;
}

/** Diagnostic sink for a handler that threw. Never rethrown. */
export type LifecycleErrorSink = (info: {
	readonly extension: string;
	readonly hook: LifecycleHook;
	readonly runId: string;
	readonly error: unknown;
}) => void;

export interface LifecycleBusOptions {
	/** Called when a subscriber throws. Defaults to a no-op (swallow). */
	readonly onError?: LifecycleErrorSink;
	/** Injectable clock for the envelope `at` stamp (tests). */
	readonly now?: () => Date;
}

interface Registered {
	readonly ext: LifecycleExtension;
}

/**
 * The observe-only lifecycle event bus. Small by design: a registry of
 * extensions and a typed fan-out. The run lifecycle calls the `emit*`
 * helpers; registered extensions observe. Nothing a subscriber does can
 * change what the emitter does next.
 */
export class LifecycleBus {
	private readonly registered = new Set<Registered>();
	private readonly onError: LifecycleErrorSink;
	private readonly now: () => Date;

	constructor(opts: LifecycleBusOptions = {}) {
		this.onError = opts.onError ?? (() => {});
		this.now = opts.now ?? (() => new Date());
	}

	/**
	 * Register a boot-wired consumer. Enforces the protocol handshake and
	 * rejects an empty subscription (an extension that names no hooks is a
	 * wiring bug, not an inert consumer). Returns a detach handle.
	 */
	register(ext: LifecycleExtension): LifecycleRegistration {
		if (ext.protocol !== WARREN_EXT_PROTOCOL) {
			throw new Error(
				`lifecycle extension "${ext.name}" negotiated protocol "${ext.protocol}", ` +
					`but this bus speaks "${WARREN_EXT_PROTOCOL}"`,
			);
		}
		const hookNames = Object.keys(ext.hooks) as LifecycleHook[];
		if (hookNames.length === 0) {
			throw new Error(`lifecycle extension "${ext.name}" subscribes to no hooks`);
		}
		for (const hook of hookNames) {
			if (!(LIFECYCLE_HOOKS as readonly string[]).includes(hook)) {
				throw new Error(`lifecycle extension "${ext.name}" names unknown hook "${hook}"`);
			}
		}
		const entry: Registered = { ext };
		this.registered.add(entry);
		return {
			name: ext.name,
			unregister: () => {
				this.registered.delete(entry);
			},
		};
	}

	/** Number of extensions subscribed to `hook` (diagnostic). */
	subscriberCount(hook: LifecycleHook): number {
		let count = 0;
		for (const { ext } of this.registered) {
			if (ext.hooks[hook] !== undefined) count += 1;
		}
		return count;
	}

	/** Names of all registered extensions (diagnostic). */
	extensionNames(): string[] {
		return [...this.registered].map((r) => r.ext.name);
	}

	/**
	 * Fan a hook out to every subscriber. Fire-and-forget: async handlers
	 * run detached and their rejections route to `onError`, so a slow or
	 * failing subscriber cannot stall or break the emitter. Returns
	 * immediately after dispatching the synchronous portion of each
	 * handler.
	 */
	emit<H extends LifecycleHook>(hook: H, runId: string, payload: LifecyclePayloads[H]): void {
		if (this.registered.size === 0) return;
		Object.freeze(payload);
		const envelope = Object.freeze<LifecycleEnvelope<H>>({
			protocol: WARREN_EXT_PROTOCOL,
			hook,
			runId,
			at: this.now().toISOString(),
			payload,
		});
		for (const { ext } of this.registered) {
			const handler = ext.hooks[hook];
			if (handler === undefined) continue;
			this.dispatch(ext.name, hook, runId, handler, envelope);
		}
	}

	private dispatch<H extends LifecycleHook>(
		extension: string,
		hook: H,
		runId: string,
		handler: LifecycleHandler<H>,
		envelope: LifecycleEnvelope<H>,
	): void {
		try {
			const result = handler(envelope);
			if (result instanceof Promise) {
				result.catch((error) => this.onError({ extension, hook, runId, error }));
			}
		} catch (error) {
			this.onError({ extension, hook, runId, error });
		}
	}

	// ---- Typed emit helpers (the run-lifecycle call-sites) --------------

	emitRunDispatched(payload: RunDispatchedPayload): void {
		this.emit("run_dispatched", payload.runId, payload);
	}

	emitRunStarted(payload: RunStartedPayload): void {
		this.emit("run_started", payload.runId, payload);
	}

	emitEventEmitted(payload: EventEmittedPayload): void {
		this.emit("event_emitted", payload.runId, payload);
	}

	emitPreReap(payload: PreReapPayload): void {
		this.emit("pre_reap", payload.runId, payload);
	}

	emitPostReap(payload: PostReapPayload): void {
		this.emit("post_reap", payload.runId, payload);
	}

	emitBranchPushed(payload: BranchPushedPayload): void {
		this.emit("branch_pushed", payload.runId, payload);
	}
}

/**
 * Boot-time registration convenience: register many extensions at once
 * and return a single detach that unwinds them all. This is the "one
 * path" boot wiring the detectors (pause detector, watchdog, ops-stats)
 * and the follow-up consumers (healer, mirrors) subscribe through — no
 * bespoke per-consumer wiring.
 */
export function registerExtensions(
	bus: LifecycleBus,
	extensions: readonly LifecycleExtension[],
): { unregisterAll(): void } {
	const handles = extensions.map((ext) => bus.register(ext));
	return {
		unregisterAll() {
			for (const handle of handles) handle.unregister();
		},
	};
}
