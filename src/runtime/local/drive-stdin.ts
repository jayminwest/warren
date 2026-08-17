/**
 * The stdin-hold controller + mid-run steering loop for the local drive loop
 * (`./drive.ts`, warren-413d) — split for the file-size budget. Source-lifted
 * in spirit from burrow's dispatcher (burrow-5db3 stdin-hold, SPEC §13.5
 * mid-run steering); the k8s analog lives in
 * `src/runtime/k8s/agent-stdin-hold.ts` (warren-0efe).
 */

import type { SpawnResult } from "../../sandbox/types.ts";
import type { AdapterRuntimeEvent, AgentRuntimeAdapter } from "../adapters/index.ts";
import { MID_RUN_INBOX_POLL_MS } from "./drive.ts";
import type { LocalRunRecord, LocalRunStore } from "./run-store.ts";

export interface StdinController {
	/** Write the adapter's auto-reply for each event (pi's RPC decline). */
	autoRespond(events: AdapterRuntimeEvent[]): Promise<void>;
	/** Close stdin when the adapter's close-trigger event lands. */
	closeOnTrigger(events: AdapterRuntimeEvent[]): Promise<void>;
	/** Defensive close at drive end so no orphaned pipe FD dangles. */
	closeIfDangling(): Promise<void>;
	/** Read-only latch for the mid-run steering loop. */
	isClosed(): boolean;
}

export function createStdinController(
	runtime: AgentRuntimeAdapter,
	proc: SpawnResult,
	active: boolean,
): StdinController {
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		await proc.closeStdin?.();
	};
	return {
		isClosed: () => closed,
		async autoRespond(events) {
			const hook = runtime.autoRespondToEvent;
			if (!active || hook === undefined || proc.writeStdin === undefined) return;
			for (const ev of events) {
				if (closed) return;
				const reply = hook(ev);
				if (reply === undefined) continue;
				try {
					await proc.writeStdin(reply.stdin);
				} catch {
					return; // sink closed underneath — the close trigger tidies up
				}
			}
		},
		async closeOnTrigger(events) {
			const trigger = runtime.shouldCloseStdinOnEvent;
			if (!active || trigger === undefined || proc.closeStdin === undefined) return;
			for (const ev of events) {
				if (trigger(ev)) {
					await close();
					return;
				}
			}
		},
		async closeIfDangling() {
			if (!active) return;
			await close().catch(() => {});
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Mid-run steering                                                            */
/* -------------------------------------------------------------------------- */

export interface MidRunHandle {
	readonly abort: () => void;
	readonly done: Promise<void>;
}

/** The slice of the drive deps the steering loop reads. */
export interface MidRunSteeringDeps {
	readonly midRunInboxPollMs?: number;
	readonly now?: () => Date;
}

/**
 * Start the mid-run steering loop (burrow's `runMidRunSteeringLoop` in
 * spirit): poll the store inbox on a short tick, write each pending row to
 * the live stdin via the adapter's encoder, mark delivered only after the
 * write lands, and emit an `inbox_delivered` system event per delivery. A
 * batch runtime (no stdin-hold / no encoder / no writable sink) gets a
 * no-op handle.
 */
export function startMidRunSteering(
	store: LocalRunStore,
	record: LocalRunRecord,
	runtime: AgentRuntimeAdapter,
	proc: SpawnResult,
	stdin: StdinController,
	deps: MidRunSteeringDeps,
): MidRunHandle {
	const encode = runtime.encodeSteeringMessage;
	const writeStdin = proc.writeStdin;
	if (encode === undefined || writeStdin === undefined) {
		return { abort: () => {}, done: Promise.resolve() };
	}
	const now = deps.now ?? (() => new Date());
	const intervalMs = deps.midRunInboxPollMs ?? MID_RUN_INBOX_POLL_MS;
	const ctrl = new AbortController();
	const tick = (): Promise<boolean> =>
		deliverPending(store, record, encode, writeStdin, stdin, ctrl.signal, now);
	const done = (async (): Promise<void> => {
		while (!ctrl.signal.aborted && !stdin.isClosed()) {
			if (!(await tick())) return;
			await sleepUntil(intervalMs, ctrl.signal);
		}
	})().catch(() => {
		// Mid-run delivery is best-effort; never fail the run on a write hiccup.
	});
	return {
		abort: () => ctrl.abort(),
		done,
	};
}

/**
 * One steering tick: deliver every pending row. Resolves `false` when the
 * loop must stop (abort, stdin closed, or a dead sink); `true` to keep
 * polling. Rows the encoder declines or a failed write leaves stay `unread`.
 */
async function deliverPending(
	store: LocalRunStore,
	record: LocalRunRecord,
	encode: NonNullable<AgentRuntimeAdapter["encodeSteeringMessage"]>,
	writeStdin: (chunk: string) => Promise<void>,
	stdin: StdinController,
	signal: AbortSignal,
	now: () => Date,
): Promise<boolean> {
	for (const row of store.listPending(record)) {
		if (signal.aborted || stdin.isClosed()) return false;
		const encoded = encode(row);
		if (encoded === undefined) continue; // declined — stays unread
		try {
			await writeStdin(encoded.stdin);
		} catch {
			return false; // sink closed — leave unread for the next poll/spawn
		}
		store.markDelivered(record, row, now);
		store.appendEvent(
			record,
			{
				kind: "inbox_delivered",
				stream: "system",
				payload: { messageId: row.id, priority: row.priority, mode: "mid_run" },
			},
			now,
		);
	}
	return true;
}

function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
