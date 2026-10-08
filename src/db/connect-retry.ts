/**
 * Bounded retry of a refused Postgres connection at acquire time (warren-a5d2).
 *
 * When the in-cluster Postgres pod restarts (an eviction, a node drain, a
 * rollout), the Service has no ready endpoint for a few seconds and every new
 * pool connection fails with `connect ECONNREFUSED`. Before this module each
 * such failure surfaced straight to the caller as a 500 — including run-event
 * appends, which a run treats as fatal (warren-fb5e) — even for a blip that
 * would have closed a second later.
 *
 * The retry is deliberately narrow. It wraps ONLY `Pool.connect()`, the point
 * where no query has been sent yet, so retrying is safe for any statement,
 * idempotent or not. A query that fails after a connection was acquired is
 * never retried here. Only two failure shapes retry, both meaning "no
 * connection was ever established":
 *
 * - a socket-level `ECONNREFUSED` (nothing is listening, or the Service has
 *   no ready endpoint), and
 * - SQLSTATE `57P03` (`cannot_connect_now`: the server is starting up or
 *   shutting down and refused the session during the handshake).
 *
 * The budget is short on purpose (~6s of backoff by default). It absorbs a
 * restart blip, not a long outage: a request held much longer than that only
 * moves the failure later while pinning the HTTP connection. Long outages are
 * prevented at the infrastructure layer instead (the postgres PDB and
 * safe-to-evict annotation, docs/RUNBOOK-K8S.md §1.5).
 *
 * `pg-pool`'s own `query()` acquires through `this.connect(cb)`, and drizzle's
 * transactions call `pool.connect()`, so overriding `connect` covers both.
 */

import { Pool, type PoolClient, type PoolConfig } from "pg";

/** Backoff delays between attempts, in ms. Length = number of retries. */
export const DEFAULT_CONNECT_RETRY_DELAYS_MS: readonly number[] = [200, 400, 800, 1600, 3200];

/** SQLSTATE cannot_connect_now: "the database system is starting up / shutting down". */
const PG_CANNOT_CONNECT_NOW = "57P03";

export interface ConnectRetryOptions {
	/** Delay before each retry, in ms. `[]` disables retrying. */
	delaysMs?: readonly number[];
	/** Injectable sleep (tests). Defaults to `Bun.sleep`. */
	sleep?: (ms: number) => Promise<void>;
	/** Called before each retry with the error that triggered it. */
	onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

function codeOf(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as { code?: unknown }).code;
}

/**
 * True when `error` means the connection was never established, so a retry
 * cannot double-apply anything. Looks one level into `cause` and into an
 * AggregateError's `errors` (Node's happy-eyeballs connect wraps per-address
 * failures that way).
 */
export function isRetryableConnectError(error: unknown): boolean {
	const code = codeOf(error);
	if (code === "ECONNREFUSED" || code === PG_CANNOT_CONNECT_NOW) return true;
	if (typeof error !== "object" || error === null) return false;
	const cause = (error as { cause?: unknown }).cause;
	if (cause !== undefined && cause !== error && isRetryableConnectError(cause)) return true;
	const errors = (error as { errors?: unknown }).errors;
	return Array.isArray(errors) && errors.length > 0 && errors.every(isRetryableConnectError);
}

/**
 * Run `connect`, retrying a refused connection per `options.delaysMs`. Any
 * other error, or a refusal after the budget is spent, rejects unchanged.
 */
export async function connectWithRetry<T>(
	connect: () => Promise<T>,
	options: ConnectRetryOptions = {},
): Promise<T> {
	const delays = options.delaysMs ?? DEFAULT_CONNECT_RETRY_DELAYS_MS;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	for (let attempt = 0; ; attempt++) {
		try {
			return await connect();
		} catch (error) {
			const delayMs = delays[attempt];
			if (delayMs === undefined || !isRetryableConnectError(error)) throw error;
			options.onRetry?.({ attempt: attempt + 1, delayMs, error });
			await sleep(delayMs);
		}
	}
}

type ConnectCallback = (
	err: Error | undefined,
	client: PoolClient | undefined,
	done: (release?: unknown) => void,
) => void;

const NOOP = (): void => {};

/**
 * A `pg.Pool` whose `connect()` retries a refused connection with bounded
 * backoff. Drop-in for `Pool`: same constructor config, same promise and
 * callback forms of `connect`.
 */
export class RetryingPool extends Pool {
	readonly #retry: ConnectRetryOptions;

	constructor(config: PoolConfig, retry: ConnectRetryOptions = {}) {
		super(config);
		this.#retry = retry;
	}

	override connect(): Promise<PoolClient>;
	override connect(callback: ConnectCallback): void;
	override connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
		const acquired = connectWithRetry(() => super.connect(), this.#retry);
		if (callback === undefined) return acquired;
		acquired.then(
			(client) => callback(undefined, client, (release) => client.release(release as Error)),
			(err: Error) => callback(err, undefined, NOOP),
		);
		return undefined;
	}
}
