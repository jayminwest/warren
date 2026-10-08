import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import {
	connectWithRetry,
	DEFAULT_CONNECT_RETRY_DELAYS_MS,
	isRetryableConnectError,
	RetryingPool,
} from "./connect-retry.ts";

function refused(): Error {
	return Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" });
}

const noSleep = async (_ms: number): Promise<void> => {};

describe("isRetryableConnectError", () => {
	test("accepts ECONNREFUSED and SQLSTATE 57P03", () => {
		expect(isRetryableConnectError(refused())).toBeTrue();
		expect(isRetryableConnectError({ code: "57P03" })).toBeTrue();
	});

	test("looks through cause and an all-refused AggregateError", () => {
		expect(isRetryableConnectError(new Error("wrapped", { cause: refused() }))).toBeTrue();
		expect(isRetryableConnectError(new AggregateError([refused(), refused()]))).toBeTrue();
	});

	test("rejects query-time and unrelated errors", () => {
		expect(isRetryableConnectError({ code: "23505" })).toBeFalse();
		expect(isRetryableConnectError({ code: "ECONNRESET" })).toBeFalse();
		expect(
			isRetryableConnectError(new Error("timeout exceeded when trying to connect")),
		).toBeFalse();
		expect(
			isRetryableConnectError(new AggregateError([refused(), new Error("other")])),
		).toBeFalse();
		expect(isRetryableConnectError(new AggregateError([]))).toBeFalse();
		expect(isRetryableConnectError(undefined)).toBeFalse();
		expect(isRetryableConnectError("ECONNREFUSED")).toBeFalse();
	});
});

describe("connectWithRetry", () => {
	test("retries refusals with the configured backoff, then returns", async () => {
		let calls = 0;
		const slept: number[] = [];
		const result = await connectWithRetry(
			async () => {
				calls++;
				if (calls < 3) throw refused();
				return "client";
			},
			{
				delaysMs: [10, 20, 30],
				sleep: async (ms) => {
					slept.push(ms);
				},
			},
		);
		expect(result).toBe("client");
		expect(calls).toBe(3);
		expect(slept).toEqual([10, 20]);
	});

	test("rethrows the last refusal once the budget is spent", async () => {
		let calls = 0;
		const retries: number[] = [];
		const err = refused();
		await expect(
			connectWithRetry(
				async () => {
					calls++;
					throw err;
				},
				{ delaysMs: [1, 2], sleep: noSleep, onRetry: ({ attempt }) => retries.push(attempt) },
			),
		).rejects.toBe(err);
		expect(calls).toBe(3);
		expect(retries).toEqual([1, 2]);
	});

	test("never retries a non-connect error", async () => {
		let calls = 0;
		const err = Object.assign(new Error("duplicate key"), { code: "23505" });
		await expect(
			connectWithRetry(
				async () => {
					calls++;
					throw err;
				},
				{ sleep: noSleep },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	test("an empty delay list disables retrying", async () => {
		let calls = 0;
		await expect(
			connectWithRetry(
				async () => {
					calls++;
					throw refused();
				},
				{ delaysMs: [], sleep: noSleep },
			),
		).rejects.toThrow("ECONNREFUSED");
		expect(calls).toBe(1);
	});

	test("the default budget stays brief", () => {
		const total = DEFAULT_CONNECT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
		expect(total).toBeLessThanOrEqual(10_000);
		expect(DEFAULT_CONNECT_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
	});
});

/**
 * Minimal Postgres wire stub: answers any StartupMessage with
 * AuthenticationOk + ReadyForQuery, which is all `pg` needs to resolve
 * `connect()`. Enough to prove a refused-then-listening port recovers.
 */
function startPgStub(port: number): Promise<Server> {
	const server = createServer((socket) => {
		socket.once("data", () => {
			const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
			const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
			socket.write(Buffer.concat([authOk, ready]));
		});
		socket.on("error", () => {});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve(server));
	});
}

/** A localhost port with nothing listening on it (bind, read, close). */
function freePort(): Promise<number> {
	const probe = createServer();
	return new Promise((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const addr = probe.address();
			const port = typeof addr === "object" && addr !== null ? addr.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

describe("RetryingPool", () => {
	const cleanup: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const fn of cleanup.splice(0)) await fn();
	});

	function pool(port: number, onRetry: () => void, delaysMs: readonly number[]): RetryingPool {
		const p = new RetryingPool(
			{ connectionString: `postgres://u:p@127.0.0.1:${port}/db`, max: 2 },
			{ delaysMs, onRetry },
		);
		cleanup.push(() => p.end().catch(() => {}));
		return p;
	}

	test("rejects with ECONNREFUSED after the budget when nothing listens", async () => {
		const port = await freePort();
		let retries = 0;
		const p = pool(port, () => retries++, [1, 1]);
		await expect(p.connect()).rejects.toMatchObject({ code: "ECONNREFUSED" });
		expect(retries).toBe(2);
	});

	test("pool.query and the callback form also go through the retry", async () => {
		const port = await freePort();
		let retries = 0;
		const p = pool(port, () => retries++, [1]);
		await expect(p.query("SELECT 1")).rejects.toMatchObject({ code: "ECONNREFUSED" });
		expect(retries).toBe(1);

		const err = await new Promise<Error | undefined>((resolve) => {
			p.connect((e) => resolve(e));
		});
		expect(err).toMatchObject({ code: "ECONNREFUSED" });
		expect(retries).toBe(2);
	});

	test("recovers when the server starts listening mid-budget", async () => {
		const port = await freePort();
		let stub: Server | undefined;
		cleanup.push(
			() => new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve())),
		);
		let retries = 0;
		const p = new RetryingPool(
			{ connectionString: `postgres://u:p@127.0.0.1:${port}/db`, max: 2 },
			{
				delaysMs: [1, 1, 1],
				sleep: async () => {
					stub ??= await startPgStub(port);
				},
				onRetry: () => retries++,
			},
		);
		cleanup.unshift(() => p.end().catch(() => {}));
		const client = await p.connect();
		expect(retries).toBe(1);
		client.release();
	});
});
