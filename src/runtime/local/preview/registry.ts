/**
 * Warren-owned preview sidecar registry (warren-4bf3, plan pl-3007 phase 3).
 * Lifted from burrow's `src/server/sidecars.ts` and re-homed onto the
 * internalized sandbox so the per-run preview seam no longer talks to the
 * burrow daemon's `POST /burrows/:id/sidecars` HTTP API.
 *
 * Sidecars are long-lived non-agent processes scoped to a run's sandbox.
 * Warren's R-19 per-run preview environments are the load-bearing consumer:
 * after the agent run terminates, warren spawns `preview.command` (e.g.
 * `bun run dev`) as a sidecar inside the same sandbox profile the agent
 * used and routes external HTTP traffic at it via an inbound port-forward
 * (`src/sandbox/inbound-forward.ts`).
 *
 * Lifecycle model (parity with the burrow registry it replaces):
 *   - Storage is in-memory (per warren server process). Sidecars are
 *     ephemeral — a server restart drops them, exactly as a burrow daemon
 *     restart did. Re-spawning across restarts is the preview subsystem's
 *     job (it re-launches from the preview row).
 *   - Each sidecar spawns through warren's own `runSandboxed`
 *     (`src/sandbox/sandbox.ts`) against the run's stored `SandboxProfile`
 *     — the same profile the agent used — resolved via the injected
 *     `profileFor` lookup (backed by the LocalProvider's run store).
 *   - Per-sandbox cap (default 4, override via `WARREN_SIDECAR_CAP`)
 *     bounds blast radius; over-cap creates throw
 *     `SidecarCapExceededError`.
 *   - `cascadeDelete` is the cleanup hook the LocalProvider's `terminate`
 *     calls so a torn-down sandbox never leaves a dev server bound to a
 *     host port.
 *
 * One behavior tighten versus burrow: a spawn or forward-bind failure
 * THROWS (with the sidecar cleaned up) instead of returning a
 * `state: "failed"` record. Burrow's HTTP handler returned 201 either
 * way, so a failed spawn surfaced downstream as a `connect_timeout`;
 * throwing lets the launch flow report the accurate `create_failed`.
 */

import { NotFoundError, ValidationError, WarrenError } from "../../../core/errors.ts";
import {
	type ForwardHandle,
	type StartForwardOptions,
	startInboundForward,
} from "../../../sandbox/inbound-forward.ts";
import { runSandboxed } from "../../../sandbox/sandbox.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../../sandbox/types.ts";

const DEFAULT_CAP = 4;

const SIDECAR_STATES = ["starting", "live", "exited", "failed", "torn-down"] as const;
export type SidecarState = (typeof SIDECAR_STATES)[number];

export interface SidecarCreateInput {
	readonly sandboxId: string;
	readonly command: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly inboundPortForward?: { hostPort: number; sandboxPort: number };
}

export interface SidecarRecord {
	readonly id: string;
	readonly sandboxId: string;
	readonly command: readonly string[];
	readonly state: SidecarState;
	readonly startedAt: Date;
	readonly exitCode: number | null;
	readonly message: string | null;
	readonly pid: number | null;
	readonly hostPortBound: boolean;
	readonly inboundPortForward: { hostPort: number; sandboxPort: number } | null;
}

export interface SidecarLogs {
	readonly stdout: string;
	readonly stderr: string;
}

/** Over-cap creates throw this; mirrors burrow's HTTP 409 shape. */
export class SidecarCapExceededError extends WarrenError {
	readonly code = "sidecar_cap_exceeded";
}

export type SidecarSpawnFn = (
	profile: SandboxProfile,
	command: SpawnCommand,
) => Promise<SpawnResult>;

export type ForwardStarter = (
	spec: { hostPort: number; sandboxPort: number; sandboxPid: number },
	options?: StartForwardOptions,
) => Promise<ForwardHandle>;

export interface LocalSidecarRegistryDeps {
	/**
	 * Resolve the sandbox profile a sidecar inherits. Backed by the
	 * LocalProvider's run store (the profile the agent spawned with); `null`
	 * when the sandbox is unknown (e.g. the record was lost to a restart),
	 * which surfaces as `NotFoundError` on create and `has() === false`.
	 */
	readonly profileFor: (sandboxId: string) => SandboxProfile | null;
	/** Test seam: alternate sandboxed-spawn impl (defaults to `runSandboxed`). */
	readonly spawn?: SidecarSpawnFn;
	/** Test seam: alternate inbound-forward starter. */
	readonly startForward?: ForwardStarter;
	/** Per-sandbox live-sidecar cap (default 4, env `WARREN_SIDECAR_CAP`). */
	readonly cap?: number;
	/** Ring-buffer size per stream (stdout / stderr); 64 KiB by default. */
	readonly logCapBytes?: number;
}

interface SidecarSession {
	id: string;
	sandboxId: string;
	command: string[];
	state: SidecarState;
	startedAt: Date;
	exitCode: number | null;
	message: string | null;
	pid: number | null;
	process: SpawnResult | null;
	forward: ForwardHandle | null;
	inboundPortForward: { hostPort: number; sandboxPort: number } | null;
	hostPortBound: boolean;
	stdoutLog: RingBuffer;
	stderrLog: RingBuffer;
}

const DEFAULT_LOG_CAP = 64 * 1024;

/**
 * Single-stream log ring-buffer. Bytes past `cap` evict the oldest chunks
 * head-first; on read we decode the remaining payload as UTF-8 (lossy but
 * adequate for the logs surface — operators reading sidecar logs accept
 * truncation as the cost of a small bound).
 */
class RingBuffer {
	private chunks: Uint8Array[] = [];
	private total = 0;
	constructor(private readonly cap: number) {}

	push(chunk: Uint8Array): void {
		this.chunks.push(chunk);
		this.total += chunk.length;
		while (this.total > this.cap && this.chunks.length > 0) {
			const head = this.chunks[0];
			if (!head) break;
			const overshoot = this.total - this.cap;
			if (head.length <= overshoot) {
				this.chunks.shift();
				this.total -= head.length;
			} else {
				this.chunks[0] = head.subarray(overshoot);
				this.total -= overshoot;
			}
		}
	}

	read(tailBytes?: number): string {
		const flat = this.flatten();
		const slice =
			tailBytes !== undefined && tailBytes < flat.length
				? flat.subarray(flat.length - tailBytes)
				: flat;
		return new TextDecoder("utf-8", { fatal: false }).decode(slice);
	}

	private flatten(): Uint8Array {
		if (this.chunks.length === 1) {
			const only = this.chunks[0];
			if (only) return only;
		}
		const out = new Uint8Array(this.total);
		let off = 0;
		for (const c of this.chunks) {
			out.set(c, off);
			off += c.length;
		}
		return out;
	}
}

export class LocalSidecarRegistry {
	private readonly bySandbox = new Map<string, Map<string, SidecarSession>>();
	private readonly cap: number;
	private readonly spawn: SidecarSpawnFn;
	private readonly startForward: ForwardStarter;
	private readonly logCap: number;
	private idSeq = 0;

	constructor(private readonly deps: LocalSidecarRegistryDeps) {
		this.cap = deps.cap ?? resolveCap();
		this.spawn = deps.spawn ?? runSandboxed;
		this.startForward = deps.startForward ?? startInboundForward;
		this.logCap = deps.logCapBytes ?? DEFAULT_LOG_CAP;
	}

	/** True when the sandbox's profile resolves (the resolver's null check). */
	has(sandboxId: string): boolean {
		return this.deps.profileFor(sandboxId) !== null;
	}

	async create(input: SidecarCreateInput): Promise<SidecarRecord> {
		const profile = this.deps.profileFor(input.sandboxId);
		if (profile === null) {
			throw new NotFoundError(
				`sandbox ${input.sandboxId} is unknown to the local backend; sidecars require a live run sandbox`,
			);
		}
		validateCommand(input.command);
		const bucket = this.bucket(input.sandboxId);
		const live = countLive(bucket);
		if (live >= this.cap) {
			throw new SidecarCapExceededError(
				`sandbox ${input.sandboxId} has ${live}/${this.cap} live sidecars; tear one down before adding another`,
				{ recoveryHint: `cap is configurable via WARREN_SIDECAR_CAP (default ${DEFAULT_CAP})` },
			);
		}

		const session: SidecarSession = {
			id: this.nextId(),
			sandboxId: input.sandboxId,
			command: [...input.command],
			state: "starting",
			startedAt: new Date(),
			exitCode: null,
			message: null,
			pid: null,
			process: null,
			forward: null,
			inboundPortForward: input.inboundPortForward ?? null,
			hostPortBound: false,
			stdoutLog: new RingBuffer(this.logCap),
			stderrLog: new RingBuffer(this.logCap),
		};
		bucket.set(session.id, session);

		const spawnCommand: SpawnCommand = { argv: [...input.command] };
		if (input.env !== undefined) spawnCommand.env = { ...input.env };
		if (input.cwd !== undefined) spawnCommand.cwd = input.cwd;

		let proc: SpawnResult;
		try {
			proc = await this.spawn(profile, spawnCommand);
		} catch (err) {
			session.state = "failed";
			session.message = err instanceof Error ? err.message : String(err);
			throw new WarrenSidecarSpawnError(session.message);
		}

		session.process = proc;
		session.pid = proc.pid;
		session.state = "live";

		if (input.inboundPortForward) {
			try {
				session.forward = await this.startForward({
					hostPort: input.inboundPortForward.hostPort,
					sandboxPort: input.inboundPortForward.sandboxPort,
					sandboxPid: proc.pid,
				});
				session.hostPortBound = session.forward.hostPortBound;
			} catch (err) {
				// Forward failure tears the sidecar down — a preview is useless
				// without inbound reachability.
				session.message = err instanceof Error ? err.message : String(err);
				session.state = "failed";
				proc.cancel();
				throw new WarrenSidecarSpawnError(session.message);
			}
		}

		streamInto(proc.stdout, session.stdoutLog);
		streamInto(proc.stderr, session.stderrLog);
		proc.exited
			.then(async (code) => {
				if (session.state === "torn-down") return;
				session.state = "exited";
				session.exitCode = code;
				await session.forward?.stop().catch(() => undefined);
			})
			.catch(async (err) => {
				if (session.state === "torn-down") return;
				session.state = "failed";
				session.message = err instanceof Error ? err.message : String(err);
				await session.forward?.stop().catch(() => undefined);
			});

		return toRecord(session);
	}

	get(sandboxId: string, sidecarId: string): SidecarRecord {
		return toRecord(this.require(sandboxId, sidecarId));
	}

	list(sandboxId: string): SidecarRecord[] {
		return [...this.bucket(sandboxId).values()].map(toRecord);
	}

	logs(sandboxId: string, sidecarId: string, tailBytes?: number): SidecarLogs {
		const session = this.require(sandboxId, sidecarId);
		return {
			stdout: session.stdoutLog.read(tailBytes),
			stderr: session.stderrLog.read(tailBytes),
		};
	}

	async delete(sandboxId: string, sidecarId: string): Promise<void> {
		await this.terminate(this.require(sandboxId, sidecarId));
	}

	/**
	 * Terminate every sidecar on the sandbox and release every forward — the
	 * hook `LocalEngine.terminate` calls so a torn-down run never strands a
	 * dev server on a host port.
	 */
	async cascadeDelete(sandboxId: string): Promise<void> {
		const bucket = this.bySandbox.get(sandboxId);
		if (!bucket) return;
		await Promise.all([...bucket.values()].map((s) => this.terminate(s)));
		this.bySandbox.delete(sandboxId);
	}

	/** Terminate every sidecar across every sandbox (server shutdown). */
	async shutdownAll(): Promise<void> {
		const sessions: SidecarSession[] = [];
		for (const bucket of this.bySandbox.values()) {
			for (const session of bucket.values()) sessions.push(session);
		}
		await Promise.all(sessions.map((s) => this.terminate(s)));
		this.bySandbox.clear();
	}

	private require(sandboxId: string, sidecarId: string): SidecarSession {
		const session = this.bucket(sandboxId).get(sidecarId);
		if (!session) {
			throw new NotFoundError(`sidecar ${sidecarId} not found on sandbox ${sandboxId}`);
		}
		return session;
	}

	private async terminate(session: SidecarSession): Promise<void> {
		if (session.state === "exited" || session.state === "torn-down" || session.state === "failed") {
			await session.forward?.stop().catch(() => undefined);
			session.forward = null;
			return;
		}
		session.state = "torn-down";
		try {
			session.process?.cancel();
		} catch {
			// already gone
		}
		await session.forward?.stop().catch(() => undefined);
		session.forward = null;
	}

	private bucket(sandboxId: string): Map<string, SidecarSession> {
		let bucket = this.bySandbox.get(sandboxId);
		if (!bucket) {
			bucket = new Map();
			this.bySandbox.set(sandboxId, bucket);
		}
		return bucket;
	}

	private nextId(): string {
		this.idSeq += 1;
		const seq = this.idSeq.toString(16).padStart(4, "0");
		const rand = Math.floor(Math.random() * 0xffff)
			.toString(16)
			.padStart(4, "0");
		return `sc_${seq}${rand}`;
	}
}

/** Spawn/forward-bind failure on create (see the module doc's tighten note). */
export class WarrenSidecarSpawnError extends WarrenError {
	readonly code = "sidecar_spawn_failed";
}

function streamInto(source: ReadableStream<Uint8Array>, sink: RingBuffer): void {
	const reader = source.getReader();
	const pump = async (): Promise<void> => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value && value.length > 0) sink.push(value);
			}
		} catch {
			// stream closed unexpectedly — sidecar terminate path handles state.
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// already released
			}
		}
	};
	pump().catch(() => undefined);
}

function countLive(bucket: Map<string, SidecarSession>): number {
	let n = 0;
	for (const s of bucket.values()) {
		if (s.state === "starting" || s.state === "live") n += 1;
	}
	return n;
}

function validateCommand(command: readonly string[]): void {
	if (!Array.isArray(command) || command.length === 0) {
		throw new ValidationError("field 'command' must be a non-empty array of strings");
	}
	for (let i = 0; i < command.length; i++) {
		const entry = command[i];
		if (typeof entry !== "string" || entry.length === 0) {
			throw new ValidationError(`command[${i}] must be a non-empty string`);
		}
	}
}

function toRecord(session: SidecarSession): SidecarRecord {
	return {
		id: session.id,
		sandboxId: session.sandboxId,
		command: [...session.command],
		state: session.state,
		startedAt: session.startedAt,
		exitCode: session.exitCode,
		message: session.message,
		pid: session.pid,
		hostPortBound: session.hostPortBound,
		inboundPortForward: session.inboundPortForward,
	};
}

function resolveCap(): number {
	const raw = process.env.WARREN_SIDECAR_CAP;
	if (raw === undefined) return DEFAULT_CAP;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1) return DEFAULT_CAP;
	return n;
}
