import { describe, expect, test } from "bun:test";
import { PassThrough, type Writable } from "node:stream";
import type { Log, LogOptions } from "@kubernetes/client-node";
import { makeLogFollow } from "./log-follow.ts";
import type { LogFollowParams } from "./log-stream.ts";

/**
 * A fake `Log` whose `.log()` drives the passed `Writable` per a script, then
 * returns an `AbortController`. Records the options it was called with so tests
 * assert the `timestamps` / `sinceSeconds` / `sinceTime` mapping.
 */
function fakeLog(
	script: (sink: Writable) => void,
	opts: { reject?: unknown } = {},
): {
	log: Log;
	calls: LogOptions[];
	abort: AbortController;
} {
	const calls: LogOptions[] = [];
	const abort = new AbortController();
	const log = {
		log: (_ns: string, _pod: string, _c: string, sink: Writable, options?: LogOptions) => {
			calls.push(options ?? {});
			if (opts.reject !== undefined) return Promise.reject(opts.reject);
			script(sink);
			return Promise.resolve(abort);
		},
	} as unknown as Log;
	return { log, calls, abort };
}

/**
 * A fake `Log` that mirrors `@kubernetes/client-node`'s real `Log.log` teardown
 * shape: it `.pipe()`s a source into the sink and wires the returned controller
 * so aborting emits an AbortError on that source. `.pipe()` never attaches a
 * source error listener, so this is the shape that crash-looped the control
 * plane on K8s teardown (warren-595f). `source` is exposed so a test can also
 * emit a non-abort mid-stream error.
 */
function fakePipedLog(): { log: Log; source: PassThrough; abort: AbortController } {
	const source = new PassThrough();
	const abort = new AbortController();
	const log = {
		log: (_ns: string, _pod: string, _c: string, sink: Writable, _options?: LogOptions) => {
			source.pipe(sink);
			abort.signal.addEventListener("abort", () => {
				const err = new Error("The user aborted a request.");
				err.name = "AbortError";
				source.emit("error", err); // transport abort surfaced on the piped body
			});
			return Promise.resolve(abort);
		},
	} as unknown as Log;
	return { log, source, abort };
}

const PARAMS: LogFollowParams = {
	namespace: "warren-runs",
	podName: "run-x",
	containerName: "agent",
	follow: true,
	timestamps: true,
};

/** Await the follow's `onDone`, collecting every `onData` chunk. */
function drive(
	fn: ReturnType<typeof makeLogFollow>,
	params: LogFollowParams,
): Promise<{ chunks: string[]; endErr: unknown }> {
	return new Promise((resolve) => {
		const chunks: string[] = [];
		void fn(
			params,
			(c) => chunks.push(c),
			(endErr) => resolve({ chunks, endErr }),
		);
	});
}

describe("makeLogFollow", () => {
	test("maps writable chunks to onData and a clean finish to onDone(undefined)", async () => {
		const fake = fakeLog((sink) => {
			sink.write("line-1\n");
			sink.write(Buffer.from("line-2\n", "utf8"));
			sink.end();
		});
		const { chunks, endErr } = await drive(makeLogFollow(fake.log), PARAMS);
		expect(chunks).toEqual(["line-1\n", "line-2\n"]);
		expect(endErr).toBeUndefined();
	});

	test("a from-start follow sets timestamps only — NO sinceSeconds, no sinceTime", async () => {
		// warren-245d: the apiserver rejects `sinceSeconds: 0` with HTTP 422
		// ("must be greater than 0"), which silently wedges the follow. A from-start
		// follow must therefore omit `sinceSeconds` entirely (a bare `follow:true`
		// replays the retained log then tails).
		const fake = fakeLog((sink) => sink.end());
		await drive(makeLogFollow(fake.log), PARAMS);
		expect(fake.calls[0]).toMatchObject({ follow: true, timestamps: true });
		expect(fake.calls[0]?.sinceSeconds).toBeUndefined();
		expect(fake.calls[0]?.sinceTime).toBeUndefined();
	});

	test("a sinceTime resume passes sinceTime and drops the mutually-exclusive sinceSeconds", async () => {
		const fake = fakeLog((sink) => sink.end());
		await drive(makeLogFollow(fake.log), { ...PARAMS, sinceTime: "2026-07-12T00:00:03Z" });
		expect(fake.calls[0]?.sinceTime).toBe("2026-07-12T00:00:03Z");
		expect(fake.calls[0]?.sinceSeconds).toBeUndefined();
	});

	test("a non-follow drain read sets neither sinceSeconds nor sinceTime", async () => {
		const fake = fakeLog((sink) => sink.end());
		await drive(makeLogFollow(fake.log), { ...PARAMS, follow: false });
		expect(fake.calls[0]?.sinceSeconds).toBeUndefined();
		expect(fake.calls[0]?.sinceTime).toBeUndefined();
		expect(fake.calls[0]?.follow).toBe(false);
	});

	test("a rejected log.log surfaces as onDone(err), never a throw", async () => {
		const boom = new Error("forbidden: pods/log");
		const fake = fakeLog(() => {}, { reject: boom });
		const { chunks, endErr } = await drive(makeLogFollow(fake.log), PARAMS);
		expect(chunks).toEqual([]);
		expect(endErr).toBe(boom);
	});

	test("abort() tears down the underlying stream and finishes exactly once", async () => {
		const fake = fakeLog((sink) => {
			sink.write("partial");
		});
		let doneCount = 0;
		const controller = await makeLogFollow(fake.log)(
			PARAMS,
			() => {},
			() => {
				doneCount += 1;
			},
		);
		controller.abort();
		controller.abort(); // idempotent
		expect(fake.abort.signal.aborted).toBe(true);
		expect(doneCount).toBe(1);
	});

	test("abort during an active follow closes the source and request without an escape", async () => {
		// client-node v2's undici path exposes request cancellation through the
		// controller, while Readable.fromWeb is only the local stream wrapper. The
		// source error guard still prevents the cancellation signal from escaping as
		// an uncaught exception.
		const fake = fakePipedLog();
		const escapes: unknown[] = [];
		const onEscape = (e: unknown): void => {
			escapes.push(e);
		};
		process.on("uncaughtException", onEscape);
		process.on("unhandledRejection", onEscape);
		try {
			let doneCount = 0;
			let endErr: unknown = "unset";
			const controller = await makeLogFollow(fake.log)(
				PARAMS,
				() => {},
				(err) => {
					doneCount += 1;
					endErr = err;
				},
			);
			controller.abort();
			// Let the (previously crashing) async uncaught-exception path settle.
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(fake.abort.signal.aborted).toBe(true);
			expect(fake.source.destroyed).toBe(true);
			expect(doneCount).toBe(1);
			expect(endErr).toBeUndefined();
			expect(escapes).toEqual([]);
		} finally {
			process.off("uncaughtException", onEscape);
			process.off("unhandledRejection", onEscape);
		}
	});

	test("an AbortError thrown synchronously OUT of abort.abort() is swallowed (warren-4e36)", async () => {
		// Under Bun the abort-event listener's AbortError can propagate through the
		// `abort.abort()` dispatching frame itself (observed live on GKE) — the
		// pipe-source listener never sees it. Teardown must not throw and must
		// still finish exactly once, cleanly.
		const throwingAbort = {
			abort: () => {
				const err = new Error("The operation was aborted.");
				err.name = "AbortError";
				throw err;
			},
		} as unknown as AbortController;
		const log = {
			log: (_ns: string, _pod: string, _c: string, sink: Writable) => {
				sink.write("partial");
				return Promise.resolve(throwingAbort);
			},
		} as unknown as Log;
		let doneCount = 0;
		let endErr: unknown = "unset";
		const controller = await makeLogFollow(log)(
			PARAMS,
			() => {},
			(err) => {
				doneCount += 1;
				endErr = err;
			},
		);
		expect(() => controller.abort()).not.toThrow();
		expect(doneCount).toBe(1);
		expect(endErr).toBeUndefined();
	});

	test("a NON-abort error thrown out of abort.abort() routes to onDone(err), never throws", async () => {
		const throwingAbort = {
			abort: () => {
				throw new Error("socket already destroyed");
			},
		} as unknown as AbortController;
		const log = {
			log: (_ns: string, _pod: string, _c: string, sink: Writable) => {
				sink.write("partial");
				return Promise.resolve(throwingAbort);
			},
		} as unknown as Log;
		let endErr: unknown = "unset";
		const controller = await makeLogFollow(log)(
			PARAMS,
			() => {},
			(err) => {
				endErr = err;
			},
		);
		expect(() => controller.abort()).not.toThrow();
		expect(endErr).toBeInstanceOf(Error);
		expect((endErr as Error).message).toBe("socket already destroyed");
	});

	test("a non-abort source error still propagates to onDone(err) for the pump to back off", async () => {
		// The swallow is scoped to AbortError only: a genuine mid-stream failure must
		// keep flowing into the pump so its reconnect/backoff (and 404 → lost) logic
		// still fires exactly as before.
		const fake = fakePipedLog();
		let endErr: unknown = "unset";
		await makeLogFollow(fake.log)(
			PARAMS,
			() => {},
			(err) => {
				endErr = err;
			},
		);
		const boom = new Error("connection reset by peer");
		fake.source.emit("error", boom);
		expect(endErr).toBe(boom);
	});
});
