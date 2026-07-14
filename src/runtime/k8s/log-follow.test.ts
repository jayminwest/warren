import { describe, expect, test } from "bun:test";
import type { Writable } from "node:stream";
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
});
