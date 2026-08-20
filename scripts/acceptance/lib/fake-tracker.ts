/**
 * Acceptance harness — cross-process driver for the FakeTracker
 * reference server (warren-53ea).
 *
 * warren boots as a SUBPROCESS (lib/inproc.ts), and the layer seam
 * (scripts/check-layers.ts, core-does-not-import-extensions) forbids
 * importing extensions/ — so the scenario spawns the reference server
 * the same way production runs it: as its own process, spoken to over
 * HTTP. The package stays the single implementation; the harness only
 * knows its CLI line protocol (`fake-tracker listening on <port>`) and
 * its state-file mirror shape.
 */

import { AcceptanceError } from "./assert.ts";

export interface FakeTrackerHandle {
	readonly url: string;
	readonly port: number;
	stop(): Promise<void>;
}

export interface SpawnFakeTrackerOptions {
	readonly fixturePath: string;
	readonly stateFilePath: string;
	/** Capability-arming CLI flags, e.g. ["--no-plans", "--no-metadata"]. */
	readonly flags?: readonly string[];
}

const LISTENING_LINE = /fake-tracker listening on (\d+)/;
const LISTEN_TIMEOUT_MS = 15_000;

/** Spawn `extensions/tracker-conformance`'s FakeTracker on an ephemeral port. */
export async function spawnFakeTracker(
	options: SpawnFakeTrackerOptions,
): Promise<FakeTrackerHandle> {
	const proc = Bun.spawn({
		cmd: [
			"bun",
			"run",
			"extensions/tracker-conformance/src/fake-tracker.ts",
			"--port",
			"0",
			"--fixture",
			options.fixturePath,
			"--state-file",
			options.stateFilePath,
			...(options.flags ?? []),
		],
		stdout: "pipe",
		stderr: "pipe",
	});

	const deadline = Date.now() + LISTEN_TIMEOUT_MS;
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	let buffered = "";
	let port: number | undefined;
	try {
		while (port === undefined && Date.now() < deadline) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += new TextDecoder().decode(value);
			const match = LISTENING_LINE.exec(buffered);
			if (match !== null) {
				port = Number.parseInt(match[1] as string, 10);
			}
		}
	} finally {
		reader.releaseLock();
	}
	if (port === undefined) {
		proc.kill();
		const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
		throw new AcceptanceError(
			`FakeTracker did not report a listening port within ${LISTEN_TIMEOUT_MS}ms; stderr: ${stderr}`,
		);
	}

	return {
		port,
		url: `http://127.0.0.1:${port}`,
		stop: async () => {
			proc.kill();
			await proc.exited;
		},
	};
}

/** Read-side view of the FakeTracker state-file mirror. */
export interface FakeTrackerStateView {
	readonly issues: readonly { readonly id: string; readonly status: string }[];
	readonly calls: readonly { readonly method: string; readonly path: string }[];
}
