/**
 * Generic list-then-watch informer loop for the K8s runtime backend. Extracted
 * from `pod-watcher.ts` (warren-32f8) so a second resource stream — the
 * pod-warning-events watcher (`pod-event-watcher.ts`) — can share the reconnect
 * / backoff / 410-relist / periodic-resync machinery instead of copy-pasting it.
 *
 * Semantics preserved verbatim from the original pod-watcher loop:
 *
 *   - Initial `list` seeds the consumer (via `onRelist`) and captures a
 *     `resourceVersion`.
 *   - `watch` resumes from that `resourceVersion`; each event advances it, so a
 *     clean disconnect RESUMES without a relist (no missed events, no dup work).
 *   - A `410 Gone` forces a full relist — the only correct recovery.
 *   - Any other disconnect reconnects after an exponential backoff, resuming
 *     from the last `resourceVersion`; each reconnect fires `onReconnect`.
 *   - An independent `resyncPeriodMs` timer force-relists (warren-4f2b) so a
 *     silently-stalled watch cannot leave a stale view past one window;
 *     `0` disables.
 *
 * The loop owns resource-version bookkeeping (including BOOKMARK events) and
 * calls `onEvent` only for real object events. `T` must be a Kubernetes object
 * carrying `metadata.resourceVersion` (both `V1Pod` and `V1Event` qualify).
 */

/** The watch phases the K8s watch callback delivers. */
export type WatchPhase = "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | string;

/** Aborts an in-flight watch — `AbortController` satisfies this structurally. */
export interface WatchController {
	abort(): void;
}

/**
 * The low-level watch seam (mirrors `@kubernetes/client-node`'s `Watch.watch`):
 * open a watch at `path` with `queryParams`, invoking `onEvent(phase, obj)` per
 * event and `onDone(err)` exactly once when the stream ends (err is the failure
 * or `undefined`/`null` on a clean server close). Resolves to a controller that
 * aborts the stream.
 */
export type ListWatchFn<T> = (
	path: string,
	queryParams: Readonly<Record<string, string | number | boolean | undefined>>,
	onEvent: (phase: WatchPhase, obj: T) => void,
	onDone: (err: unknown) => void,
) => Promise<WatchController>;

/** Lists the current page of objects + its resourceVersion (one page assumed). */
export type ListFn<T> = () => Promise<{
	items: T[];
	resourceVersion: string | undefined;
}>;

export interface ListWatchLoopDeps<T> {
	/** Log-line prefix distinguishing the streams ("pod-watch", "pod-event-watch"). */
	readonly label: string;
	/** Fully-built watch path (namespace baked in). */
	readonly path: string;
	/** Extra query params (labelSelector / fieldSelector / bookmarks). */
	readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
	readonly list: ListFn<T>;
	readonly watch: ListWatchFn<T>;
	/** Fold a fresh list page into the consumer (pod cache reconcile, event dedupe). */
	readonly onRelist: (items: T[]) => void;
	/** Fold one watch event into the consumer. BOOKMARKs never reach here. */
	readonly onEvent: (phase: WatchPhase, obj: T) => void;
	/** Fired once per watch re-attach (the reconnect metric hook). */
	readonly onReconnect?: () => void;
	/** Backoff floor / ceiling for reconnects (ms). Defaults 1s / 30s. */
	readonly backoffBaseMs?: number;
	readonly backoffMaxMs?: number;
	/**
	 * Periodic force-relist cadence (ms). Default `DEFAULT_RESYNC_PERIOD_MS`
	 * (5 min); `0` disables. See warren-4f2b (a silently-stalled watch must not
	 * leave a stale view indefinitely).
	 */
	readonly resyncPeriodMs?: number;
	readonly logger?: {
		info?: (obj: unknown, msg: string) => void;
		warn?: (obj: unknown, msg: string) => void;
	};
}

const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

/**
 * Force-relist cadence (warren-4f2b): 5 minutes. Bounds the worst-case window a
 * stale view can survive a silent watch by. Defined here so every informer loop
 * shares the one default; re-exported by `pod-watcher.ts` for its existing
 * consumers. Override via `WARREN_K8S_POD_WATCHER_RESYNC_MS`; `0` disables.
 */
export const DEFAULT_RESYNC_PERIOD_MS = 5 * 60 * 1000;

/**
 * The list-then-watch loop. Construct with the injected seams, call `start()`
 * to seed + begin watching, `stop()` to abort and await the loop's exit.
 */
export class ListWatchLoop<T> {
	private resourceVersion: string | undefined;
	private running = false;
	private activeWatch: WatchController | undefined;
	/** Resolver for the in-flight `watchOnce` — invoked by `stop()` so the loop
	 * unparks even when the underlying watch never fires its own `done`. */
	private resolveWatch: ((err: unknown) => void) | undefined;
	private loopDone: Promise<void> | undefined;
	private backoffMs: number;
	/** Periodic force-relist timer (warren-4f2b). Cleared by `stop()`. */
	private resyncTimer: ReturnType<typeof setInterval> | undefined;
	/** Serializes a resync relist against the watch loop's own relist path. */
	private relistInFlight: Promise<void> | undefined;
	/**
	 * Informer sync state (warren-39e1): `true` once a list has seeded the
	 * consumer and the watch stream is attached; flips `false` when the API
	 * server becomes unreachable (list failure or watch-attach/stream error).
	 * The `/readyz` `k8s_api_reachable` check reads this as the positive
	 * K8s-topology readiness signal.
	 */
	private synced = false;

	constructor(private readonly deps: ListWatchLoopDeps<T>) {
		this.backoffMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
	}

	/** Begin watching. Idempotent — a second call while running is a no-op. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.loopDone = this.loop();
		this.scheduleResync();
	}

	/**
	 * Whether the informer has synced against the API server (warren-39e1).
	 * `true` after the initial list succeeds and while a watch stream is
	 * attached; `false` before the first successful list and after a list
	 * failure or a watch error (until the next successful attach/relist).
	 */
	isSynced(): boolean {
		return this.synced;
	}

	/** Abort the watch and await the loop's exit. Idempotent. */
	async stop(): Promise<void> {
		this.running = false;
		if (this.resyncTimer !== undefined) {
			clearInterval(this.resyncTimer);
			this.resyncTimer = undefined;
		}
		this.activeWatch?.abort();
		this.activeWatch = undefined;
		// Unpark a `watchOnce` that is still waiting on `done` (abort may not fire
		// it) so the loop sees `!running` and exits rather than hanging `stop()`.
		this.resolveWatch?.(undefined);
		await this.loopDone?.catch(() => {});
		this.loopDone = undefined;
	}

	/**
	 * Schedule the periodic force-relist (warren-4f2b). A resync tick is a
	 * definitive server-truth snapshot: `onRelist` drops anything absent from
	 * the fresh page, so a stale entry cannot survive past one window.
	 * `resyncPeriodMs: 0` opts out.
	 */
	private scheduleResync(): void {
		const period = this.deps.resyncPeriodMs ?? DEFAULT_RESYNC_PERIOD_MS;
		if (period <= 0) return;
		this.resyncTimer = setInterval(() => {
			if (!this.running) return;
			// Fire-and-forget: the loop's own relist path awaits `relistInFlight`
			// so this can't race with a concurrent 410 relist.
			void this.resyncRelist();
		}, period);
	}

	/**
	 * Serialize a force-relist against the watch loop's own relist (warren-4f2b).
	 * A resync tick that fires while the loop is already relisting after a 410
	 * awaits that relist rather than issuing a redundant API call.
	 */
	private async resyncRelist(): Promise<void> {
		if (this.relistInFlight !== undefined) {
			await this.relistInFlight;
			return;
		}
		this.deps.logger?.info?.(
			{ label: this.deps.label },
			`${this.deps.label} periodic resync; relisting`,
		);
		const promise = this.safeRelist();
		this.relistInFlight = promise.finally(() => {
			this.relistInFlight = undefined;
		});
		await this.relistInFlight;
	}

	// --- Watch loop ----------------------------------------------------------

	private async loop(): Promise<void> {
		await this.safeRelist();
		while (this.running) {
			const err = await this.watchOnce();
			if (!this.running) break;
			// The watch stream ended (clean close or error). Re-attach.
			this.deps.onReconnect?.();
			if (isGone(err)) {
				this.deps.logger?.info?.(
					{ label: this.deps.label },
					`${this.deps.label} 410 gone; relisting`,
				);
				await this.safeRelist();
				this.resetBackoff();
			} else {
				this.deps.logger?.warn?.(
					{ label: this.deps.label, err: errText(err) },
					`${this.deps.label} disconnected; backing off before resume`,
				);
				await this.sleep(this.nextBackoff());
			}
		}
	}

	/** Re-list from scratch: hand the server's truth to the consumer + capture RV. */
	private async safeRelist(): Promise<void> {
		try {
			const { items, resourceVersion } = await this.deps.list();
			this.deps.onRelist(items);
			this.resourceVersion = resourceVersion;
			this.synced = true;
			this.resetBackoff();
		} catch (err) {
			this.synced = false;
			this.deps.logger?.warn?.(
				{ label: this.deps.label, err: errText(err) },
				`${this.deps.label} list failed; backing off`,
			);
			if (this.running) await this.sleep(this.nextBackoff());
		}
	}

	/** Open one watch; resolve with the terminating error (or `undefined`). */
	private watchOnce(): Promise<unknown> {
		return new Promise<unknown>((resolve) => {
			let settled = false;
			const done = (err: unknown): void => {
				if (settled) return;
				settled = true;
				this.resolveWatch = undefined;
				// An error terminating the stream means the API connection broke;
				// a clean server close keeps the synced state (we resume).
				if (err !== undefined && err !== null) this.synced = false;
				resolve(err);
			};
			this.resolveWatch = done;
			const query: Record<string, string | number | boolean | undefined> = {
				...this.deps.query,
				...(this.resourceVersion !== undefined ? { resourceVersion: this.resourceVersion } : {}),
			};
			this.deps
				.watch(this.deps.path, query, (phase, obj) => this.handleEvent(phase, obj), done)
				.then((controller) => {
					this.activeWatch = controller;
					// A successful attach re-establishes the API connection after a
					// transient disconnect — the informer is live again.
					this.synced = true;
					if (!this.running) controller.abort();
				})
				.catch((err) => {
					this.synced = false;
					done(err);
				});
		});
	}

	/**
	 * Advance the resume cursor from every object (including BOOKMARKs, which
	 * carry ONLY an advanced resourceVersion), then hand real events to the
	 * consumer. The cursor moves even for objects the consumer ignores, so a
	 * reconnect resumes past them rather than re-delivering.
	 */
	private handleEvent(phase: WatchPhase, obj: T): void {
		const rv = metadataOf(obj)?.resourceVersion;
		if (rv !== undefined) this.resourceVersion = rv;
		if (phase === "BOOKMARK") return;
		this.deps.onEvent(phase, obj);
	}

	// --- Backoff -------------------------------------------------------------

	private nextBackoff(): number {
		const current = this.backoffMs;
		const max = this.deps.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
		this.backoffMs = Math.min(current * 2, max);
		return current;
	}

	private resetBackoff(): void {
		this.backoffMs = this.deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
	}

	private sleep(ms: number): Promise<void> {
		if (ms <= 0) return Promise.resolve();
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/** The `metadata` carrier both pods and events satisfy. */
function metadataOf(obj: unknown): { resourceVersion?: string } | undefined {
	return (obj as { metadata?: { resourceVersion?: string } }).metadata;
}

/** A `410 Gone` — the resourceVersion aged out of etcd's window; relist. */
function isGone(err: unknown): boolean {
	if (err === undefined || err === null) return false;
	const code = (err as { code?: unknown; statusCode?: unknown }).code;
	const statusCode = (err as { statusCode?: unknown }).statusCode;
	if (code === 410 || statusCode === 410) return true;
	const msg = errText(err);
	return /\b410\b/.test(msg) || /gone|expired|too old resource version/i.test(msg);
}

function errText(err: unknown): string {
	if (err === undefined || err === null) return "";
	if (err instanceof Error) return err.message;
	return String(err);
}
