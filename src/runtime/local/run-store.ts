/**
 * The LocalProvider's in-process run store (warren-413d, plan pl-3007 phase 3).
 *
 * With the burrow daemon off the spawn path, the provider itself owns the
 * per-run state burrow's SQLite used to hold: the event log (monotonic
 * per-run `seq`, persisted DIRECTLY here as the drive loop parses agent
 * output — no HTTP round-trip), the steering inbox (unread→delivered
 * lifecycle, priority-desc-then-FIFO claim), and the coarse run phase the
 * `status()` reconcile snapshot reads.
 *
 * In-memory is a behavior PARITY choice, not a regression: burrow's own
 * store was per-daemon and wiped on restart (`./status.ts`'s lost-run note),
 * and the durable warren-side copy of every event is written by the domain's
 * event bridge (`src/runs/stream/bridge.ts`) as it consumes
 * `streamEvents`. A warren restart therefore reconciles live runs as `lost`
 * exactly as a burrow-daemon restart did.
 *
 * One record per run; `sandboxId` and `providerRunId` are both unique per
 * run under the in-process backend (one sandbox per run), so the store
 * indexes both.
 */

import type { EventStream, InboxState } from "../../core/wire.ts";
import type { SandboxProfile, SpawnResult } from "../../sandbox/types.ts";
import type { MessagePriority, NormalizedEvent, RunPhase, TerminalReason } from "../contract.ts";

/** One persisted event — the store assigns `seq`/`ts` at append time. */
export interface StoredEvent {
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: EventStream | null;
	readonly payload: unknown;
}

/** The steering-inbox row — burrow's `messages` table, warren-owned. */
export interface LocalInboxRow {
	readonly id: string;
	readonly body: string;
	readonly priority: MessagePriority;
	readonly fromActor: string;
	state: InboxState;
	readonly createdAt: string;
	deliveredAt: string | null;
	/** The run that claimed the message; `null` while unread. */
	deliveredAtRunId: string | null;
}

/** Priority rank for the claim ordering (priority desc, then FIFO). */
const PRIORITY_RANK: Record<MessagePriority, number> = {
	urgent: 3,
	high: 2,
	normal: 1,
	low: 0,
};

export interface LocalRunRecord {
	/** warren domain run id (== `providerRunId` under the in-process backend). */
	readonly runId: string;
	/** Provider workspace id — `local-<runId>`; the manifest/workspace dir key. */
	readonly sandboxId: string;
	readonly providerRunId: string;
	/** Absolute host path of the materialized workspace. */
	readonly workspacePath: string;
	/** Absolute host path of the run's private writable HOME (warren-c865). */
	readonly homePath: string;
	/** The run's push branch. */
	readonly branch: string;
	phase: RunPhase;
	exitCode: number | null;
	terminalReason: TerminalReason | null;
	errorMessage: string | null;
	/** Set by `cancel()`; the drive loop terminalizes `cancelled` off it. */
	cancelRequested: boolean;
	readonly events: StoredEvent[];
	readonly inbox: LocalInboxRow[];
	/** Monotonic per-run event cursor — the next `seq` to assign. */
	nextSeq: number;
	/** The live sandboxed child; null before spawn completes / after teardown. */
	proc: SpawnResult | null;
	/**
	 * The sandbox profile the agent spawned with (warren-4bf3). Preview
	 * sidecars inherit it so a dev server runs inside the same sandbox
	 * profile the agent used. Null only for records created without one
	 * (unit-test fixtures); the engine always sets it.
	 */
	readonly profile: SandboxProfile | null;
	/** Wakes suspended `streamEvents` consumers on append/terminalize. */
	readonly waiters: Set<() => void>;
}

export interface CreateRecordInput {
	readonly runId: string;
	readonly sandboxId: string;
	readonly workspacePath: string;
	readonly homePath: string;
	readonly branch: string;
	/** The run's sandbox profile (see `LocalRunRecord.profile`). */
	readonly profile?: SandboxProfile;
}

export class LocalRunStore {
	private readonly byRunId = new Map<string, LocalRunRecord>();
	private readonly bySandboxId = new Map<string, LocalRunRecord>();

	create(input: CreateRecordInput): LocalRunRecord {
		const record: LocalRunRecord = {
			runId: input.runId,
			sandboxId: input.sandboxId,
			providerRunId: input.runId,
			workspacePath: input.workspacePath,
			homePath: input.homePath,
			branch: input.branch,
			phase: "queued",
			exitCode: null,
			terminalReason: null,
			errorMessage: null,
			cancelRequested: false,
			events: [],
			inbox: [],
			nextSeq: 1,
			proc: null,
			profile: input.profile ?? null,
			waiters: new Set(),
		};
		this.byRunId.set(record.providerRunId, record);
		this.bySandboxId.set(record.sandboxId, record);
		return record;
	}

	getByRunId(providerRunId: string): LocalRunRecord | undefined {
		return this.byRunId.get(providerRunId);
	}

	getBySandboxId(sandboxId: string): LocalRunRecord | undefined {
		return this.bySandboxId.get(sandboxId);
	}

	remove(record: LocalRunRecord): void {
		this.byRunId.delete(record.providerRunId);
		this.bySandboxId.delete(record.sandboxId);
		// Wake any suspended consumers so a stream attached at terminate time
		// drains and ends instead of hanging on a record that is gone.
		this.notify(record);
	}

	/**
	 * Append one event, assigning the per-run monotonic `seq` and the
	 * timestamp. `origin: "warren"` is stamped by the stream mapper (host-side
	 * classification, warren-6646) — the store keeps the payload verbatim.
	 */
	appendEvent(
		record: LocalRunRecord,
		event: { kind: string; stream: EventStream | null; payload: unknown },
		now: () => Date = () => new Date(),
	): StoredEvent {
		const stored: StoredEvent = {
			seq: record.nextSeq,
			ts: now().toISOString(),
			kind: event.kind,
			stream: event.stream,
			payload: event.payload,
		};
		record.nextSeq += 1;
		record.events.push(stored);
		this.notify(record);
		return stored;
	}

	/** Mark the record running (the drive loop has spawned the agent). */
	markRunning(record: LocalRunRecord): void {
		if (record.phase === "queued") record.phase = "running";
	}

	/**
	 * Terminalize the record and wake every suspended stream consumer.
	 * Idempotent once a terminal phase is set (warren-8a6e): `LocalEngine.cancel`
	 * settles `cancelled` immediately, and later drive-loop paths (kill-exit
	 * mapping, catch-all error terminalize) must not overwrite that outcome.
	 */
	terminalize(
		record: LocalRunRecord,
		outcome: {
			phase: RunPhase;
			exitCode: number | null;
			terminalReason: TerminalReason;
			errorMessage?: string | null;
		},
	): void {
		if (this.isTerminal(record)) {
			this.notify(record);
			return;
		}
		record.phase = outcome.phase;
		record.exitCode = outcome.exitCode;
		record.terminalReason = outcome.terminalReason;
		record.errorMessage = outcome.errorMessage ?? null;
		this.notify(record);
	}

	/** True once the record carries a terminal phase. */
	isTerminal(record: LocalRunRecord): boolean {
		return (
			record.phase === "succeeded" || record.phase === "failed" || record.phase === "cancelled"
		);
	}

	/** Enqueue a steering message; defaults mirror burrow's inbox.send. */
	sendMessage(
		record: LocalRunRecord,
		msg: { body: string; priority?: MessagePriority; fromActor?: string },
		now: () => Date = () => new Date(),
	): LocalInboxRow {
		const row: LocalInboxRow = {
			id: `msg_${crypto.randomUUID()}`,
			body: msg.body,
			priority: msg.priority ?? "normal",
			fromActor: msg.fromActor ?? "user",
			state: "unread",
			createdAt: now().toISOString(),
			deliveredAt: null,
			deliveredAtRunId: null,
		};
		record.inbox.push(row);
		return row;
	}

	/** Pending rows in claim order: priority desc, then FIFO by arrival. */
	listPending(record: LocalRunRecord): LocalInboxRow[] {
		return record.inbox
			.filter((row) => row.state === "unread")
			.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
	}

	/** Atomically claim every pending row for the run (spawn-time drain). */
	claimPending(record: LocalRunRecord, now: () => Date = () => new Date()): LocalInboxRow[] {
		const pending = this.listPending(record);
		for (const row of pending) this.markDelivered(record, row, now);
		return pending;
	}

	/** Mark one row delivered against the record's run. */
	markDelivered(
		record: LocalRunRecord,
		row: LocalInboxRow,
		now: () => Date = () => new Date(),
	): void {
		row.state = "delivered";
		row.deliveredAt = now().toISOString();
		row.deliveredAtRunId = record.providerRunId;
	}

	/** Suspend until the next append/terminalize/remove on this record. */
	waitForChange(record: LocalRunRecord): Promise<void> {
		return new Promise((resolve) => {
			record.waiters.add(resolve);
		});
	}

	private notify(record: LocalRunRecord): void {
		const waiters = [...record.waiters];
		record.waiters.clear();
		for (const wake of waiters) wake();
	}
}

/** Re-shape a stored row onto the seam's `NormalizedEvent` (origin warren-stamped). */
export function toNormalizedEvent(stored: StoredEvent): NormalizedEvent {
	return {
		seq: stored.seq,
		ts: stored.ts,
		kind: stored.kind,
		stream: stored.stream,
		origin: "warren",
		payload: stored.payload,
	};
}
