/**
 * The stdin-hold subsystem for the in-pod agent entrypoint (warren-7a43, design
 * k8s-migration.md §5.1). Mirrors burrow's dispatcher (`src/runner/dispatch.ts`)
 * for runtimes whose CLI exits the instant stdin closes mid-inference (pi, and
 * anything else that declares `AgentRuntimeAdapter.shouldCloseStdinOnEvent`):
 *
 *   • keep stdin open past the prompt and close it only when the runtime's
 *     terminal event lands (pi's `agent_end`) — the old unconditional
 *     close-at-spawn made pi exit having done no work (burrow-5db3);
 *   • auto-reply to any intervening request envelope the runtime emits
 *     (`autoRespondToEvent`) so an interactive prompt can't hang the batch run;
 *   • deliver mid-run steering messages to the live stdin
 *     (`encodeSteeringMessage`) by polling the inbox while the run is in flight;
 *   • guard against a hung run with an idle watchdog that drops stdin and
 *     force-kills so a stalled inference can't pin the pod forever.
 *
 * A batch runtime (claude-code `--print`) declares none of these seams,
 * so `createStdinHoldController({ active: false, … })` returns a no-op and the
 * entrypoint keeps its write-and-close-at-spawn behavior unchanged.
 */

import type { AcceptedRuntimeId } from "../../core/wire.ts";
import type {
	AdapterRuntimeEvent,
	AgentRuntimeAdapter,
	SteeringMessage,
} from "../adapters/index.ts";
import type { AgentEntrypointEnv } from "./agent-entrypoint.ts";
import {
	type AgentInboxHttp,
	type AgentProc,
	drainInbox,
	emitSystem,
	sleepUntil,
} from "./agent-io.ts";

/**
 * The stdin lifecycle a stdin-held runtime needs on top of the plain pump loop.
 * `onOutput`/`onEvents` hang off the stdout pump; `start`/`stop` bracket the run.
 */
export interface StdinHoldController {
	/** Arm the idle watchdog + kick off the mid-run steering poll. */
	start(): void;
	/** Reset the idle watchdog — call on every stdout line. */
	onOutput(): void;
	/** Auto-reply + close-on-terminal-event for a batch of parsed events. */
	onEvents(events: AdapterRuntimeEvent[]): Promise<void>;
	/** Tear down: stop timers + steering, then defensively close stdin. */
	stop(): Promise<void>;
}

export interface StdinHoldControllerArgs {
	active: boolean;
	env: AgentEntrypointEnv;
	runtime: AgentRuntimeAdapter;
	proc: AgentProc;
	http: AgentInboxHttp;
	out: (line: string) => void;
	log: (m: string) => void;
}

const NOOP_STDIN_HOLD: StdinHoldController = {
	start: () => {},
	onOutput: () => {},
	onEvents: async () => {},
	stop: async () => {},
};

/**
 * Encapsulate the stdin-hold contract for a runtime that declares
 * `shouldCloseStdinOnEvent`: keep stdin open past the prompt, close it on the
 * runtime's terminal event (auto-replying to any intervening request envelope),
 * deliver mid-run steering to the live stdin, and guard against a hung run with
 * an idle watchdog. For a batch runtime (`active: false`) this is a no-op.
 * (warren-7a43, mirrors burrow `dispatch.ts`.)
 */
export function createStdinHoldController(args: StdinHoldControllerArgs): StdinHoldController {
	const { active, env, runtime, proc, http, out, log } = args;
	if (!active) return NOOP_STDIN_HOLD;

	let stdinClosed = false;
	const isStdinClosed = (): boolean => stdinClosed;
	const closeStdinOnce = async (): Promise<void> => {
		if (stdinClosed || proc.closeStdin === undefined) return;
		stdinClosed = true;
		await proc.closeStdin();
	};

	const watchdog = createIdleWatchdog({
		timeoutMs: env.stdinHoldIdleTimeoutMs,
		runtimeId: runtime.runtimeId,
		out,
		log,
		isStdinClosed,
		kill: proc.kill,
		killGraceMs: env.stdinHoldKillGraceMs,
		onTimeout: () => {
			// warren-9a4a: swallow a rejection here — closing the stdin of an
			// already-dead child throws EPIPE, and an unhandled rejection inside
			// the watchdog timer is fatal to the pod process (the sibling call in
			// `stop()` already catches).
			void closeStdinOnce().catch(() => {});
		},
	});

	const midRunAbort = new AbortController();
	const steeringLoop: Promise<void> =
		typeof runtime.encodeSteeringMessage === "function" && proc.writeStdin !== undefined
			? runMidRunSteeringLoop({
					env,
					http,
					runtime,
					log,
					writeStdin: proc.writeStdin,
					isStdinClosed,
					onWrite: () => watchdog.arm(),
					signal: midRunAbort.signal,
				}).catch(() => {
					// Mid-run delivery is best-effort; never fail an otherwise good run.
				})
			: Promise.resolve();

	return {
		start: () => watchdog.arm(),
		onOutput: () => {
			if (!stdinClosed) watchdog.arm();
		},
		onEvents: async (events) => {
			await autoRespondToEvents(runtime, proc, events, isStdinClosed);
			if (!stdinClosed && firstEventMatches(runtime.shouldCloseStdinOnEvent, events)) {
				await closeStdinOnce();
			}
		},
		stop: async () => {
			watchdog.clear();
			midRunAbort.abort();
			await steeringLoop;
			// Defensive: if the child exited before emitting its close-trigger event,
			// drop the dangling write FD (closeStdin is idempotent). Mirrors burrow.
			await closeStdinOnce().catch(() => {});
		},
	};
}

/** True when any event satisfies the runtime's stdin-close predicate. */
function firstEventMatches(
	predicate: ((event: AdapterRuntimeEvent) => boolean) | undefined,
	events: AdapterRuntimeEvent[],
): boolean {
	return predicate !== undefined && events.some((ev) => predicate(ev));
}

/**
 * Give the runtime a chance to synthesize a stdin reply to each event (e.g. pi
 * declining an interactive extension_ui prompt) before the close-trigger check.
 * A closed sink or an absent hook/writer short-circuits. Best-effort.
 */
async function autoRespondToEvents(
	runtime: AgentRuntimeAdapter,
	proc: AgentProc,
	events: AdapterRuntimeEvent[],
	isStdinClosed: () => boolean,
): Promise<void> {
	const autoRespond = runtime.autoRespondToEvent;
	const writeStdin = proc.writeStdin;
	if (autoRespond === undefined || writeStdin === undefined) return;
	for (const ev of events) {
		if (isStdinClosed()) return;
		const reply = autoRespond(ev);
		if (reply === undefined) continue;
		try {
			await writeStdin(reply.stdin);
		} catch {
			return; // sink closed underneath us — the close-trigger will tidy up
		}
	}
}

interface IdleWatchdog {
	arm(): void;
	clear(): void;
}

interface IdleWatchdogArgs {
	timeoutMs: number;
	/** Grace between the stdin close and the hard kill (warren-9a4a env knob). */
	killGraceMs: number;
	runtimeId: AcceptedRuntimeId;
	out: (line: string) => void;
	log: (m: string) => void;
	isStdinClosed: () => boolean;
	kill: (() => void) | undefined;
	onTimeout: () => void;
}

/**
 * Idle watchdog for a stdin-held run: if the child produces no output for
 * `timeoutMs` while stdin is held open, emit a `stdin_hold_timeout` witness,
 * close stdin (nudging an EOF-triggered clean exit), and hard-kill after a grace
 * so a hung inference can't pin the pod. `timeoutMs <= 0` disables it. (warren-7a43)
 */
function createIdleWatchdog(args: IdleWatchdogArgs): IdleWatchdog {
	const { timeoutMs, killGraceMs, runtimeId, out, log, isStdinClosed, kill, onTimeout } = args;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const clear = (): void => {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		if (killTimer !== undefined) clearTimeout(killTimer);
		idleTimer = undefined;
		killTimer = undefined;
	};
	const arm = (): void => {
		if (timeoutMs <= 0 || isStdinClosed()) return;
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			emitSystem(out, "stdin_hold_timeout", { idleMs: timeoutMs });
			log(
				`agent-entrypoint: '${runtimeId}' produced no output for ${timeoutMs}ms with stdin held; closing stdin + killing`,
			);
			// Arm the hard-kill synchronously (so `clear()` can always cancel it) —
			// it fires only if closing stdin doesn't produce a clean exit in time.
			killTimer = setTimeout(() => kill?.(), killGraceMs);
			onTimeout();
		}, timeoutMs);
	};
	return { arm, clear };
}

interface MidRunSteeringLoopArgs {
	env: AgentEntrypointEnv;
	http: AgentInboxHttp;
	runtime: AgentRuntimeAdapter;
	log: (m: string) => void;
	writeStdin: (chunk: string) => Promise<void>;
	isStdinClosed: () => boolean;
	/** Reset the idle watchdog after a successful steering write. */
	onWrite: () => void;
	signal: AbortSignal;
}

/**
 * Poll the run's steering inbox on `inboxPollIntervalMs` while a stdin-held run
 * is in flight; encode each newly-claimed message through the runtime's
 * `encodeSteeringMessage` and write it to the still-open stdin. Best-effort:
 * write/encode/drain failures are swallowed so a mid-run nudge never fails an
 * otherwise successful run. Stops on abort or once stdin has been closed (the
 * runtime is finishing). Mirrors burrow's `runMidRunSteeringLoop`. (warren-7a43)
 */
async function runMidRunSteeringLoop(args: MidRunSteeringLoopArgs): Promise<void> {
	const { env, http, runtime, log, writeStdin, isStdinClosed, onWrite, signal } = args;
	const encode = runtime.encodeSteeringMessage;
	if (encode === undefined) return;
	const stopped = (): boolean => signal.aborted || isStdinClosed();
	while (!stopped()) {
		await sleepUntil(env.inboxPollIntervalMs, signal);
		if (stopped()) break;
		const messages = await drainInbox(env, http, log);
		const outcome = await deliverSteeringBatch({ messages, encode, writeStdin, onWrite, stopped });
		if (outcome === "sink-closed") return;
	}
}

interface DeliverSteeringBatchArgs {
	messages: SteeringMessage[];
	encode: (message: SteeringMessage) => { stdin: string } | undefined;
	writeStdin: (chunk: string) => Promise<void>;
	onWrite: () => void;
	stopped: () => boolean;
}

/** Encode + write one drained batch to the held stdin; report a dead sink. */
async function deliverSteeringBatch(
	args: DeliverSteeringBatchArgs,
): Promise<"delivered" | "sink-closed"> {
	const { messages, encode, writeStdin, onWrite, stopped } = args;
	for (const message of messages) {
		if (stopped()) break;
		const encoded = encode(message);
		if (encoded === undefined) continue;
		try {
			await writeStdin(encoded.stdin);
			onWrite();
		} catch {
			return "sink-closed";
		}
	}
	return "delivered";
}
