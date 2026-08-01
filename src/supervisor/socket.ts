/**
 * Wait until a unix socket file appears on disk (docs/design/runtime-and-supervisor.md).
 *
 * The supervisor spawns `burrow serve --socket <path>` and then needs to wait
 * until burrow has actually opened the socket before it spawns warren — a
 * warren process that boots before burrow's socket exists fails its startup
 * burrow probe and emits a noisy warning.
 *
 * docs/design/runtime-and-supervisor.md specifies `fs.access` poll, 100 ms × 50 = 5s total. The polling
 * interval and timeout are injectable so tests can drive them quickly.
 */

import { promises as fs } from "node:fs";

export interface WaitForSocketOptions {
	readonly intervalMs?: number;
	readonly timeoutMs?: number;
	/** Override the existence check (tests). */
	readonly exists?: (path: string) => Promise<boolean>;
	/** Override `setTimeout` sleep (tests). */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Override `Date.now` (tests). */
	readonly now?: () => number;
}

export const DEFAULT_INTERVAL_MS = 100;
export const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Resolves to `true` once the socket file exists, or `false` if the timeout
 * elapses without the file appearing. Does not throw; the caller decides
 * whether a failure is fatal.
 */
export async function waitForSocket(
	path: string,
	opts: WaitForSocketOptions = {},
): Promise<boolean> {
	const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const exists = opts.exists ?? defaultExists;
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? Date.now;

	const deadline = now() + timeoutMs;
	while (true) {
		if (await exists(path)) return true;
		if (now() >= deadline) return false;
		await sleep(intervalMs);
	}
}

async function defaultExists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
