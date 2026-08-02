import { describe, expect, test } from "bun:test";
import { renderError } from "./errors.ts";
import {
	DEFAULT_EVENT_STREAM_MAX_LIFETIME_MS,
	DEFAULT_EVENT_STREAM_TRUSTED_PROXY_HOPS,
	DEFAULT_MAX_EVENT_STREAMS,
	DEFAULT_MAX_EVENT_STREAMS_PER_CLIENT,
	EVENT_STREAM_RETRY_AFTER_SECONDS,
	EventStreamCapacityError,
	EventStreamConfigError,
	EventStreamLimiter,
	eventStreamClientKey,
	loadEventStreamLimitsFromEnv,
	reserveEventStreamSlot,
} from "./stream-limits.ts";
import type { Logger, RouteContext } from "./types.ts";

function limiter(
	overrides: Partial<ConstructorParameters<typeof EventStreamLimiter>[0]> = {},
): EventStreamLimiter {
	return new EventStreamLimiter({
		maxGlobal: 0,
		maxPerClient: 0,
		maxLifetimeMs: 0,
		trustedProxyHops: 0,
		...overrides,
	});
}

function ctxFor(
	init: { headers?: Record<string, string>; clientIp?: string; logger?: Logger } = {},
): RouteContext {
	return {
		request: new Request("http://warren.test/runs/r1/events", { headers: init.headers ?? {} }),
		url: new URL("http://warren.test/runs/r1/events"),
		params: { id: "r1" },
		logger: init.logger ?? { info() {}, warn() {}, error() {} },
		requestId: "req-1",
		...(init.clientIp !== undefined ? { clientIp: init.clientIp } : {}),
	};
}

interface LoggedLine {
	level: "info" | "warn" | "error";
	obj: Record<string, unknown>;
	msg: string | undefined;
}

function recordingLogger(): { logger: Logger; lines: LoggedLine[] } {
	const lines: LoggedLine[] = [];
	return {
		lines,
		logger: {
			info: (obj, msg) => lines.push({ level: "info", obj: obj as Record<string, unknown>, msg }),
			warn: (obj, msg) => lines.push({ level: "warn", obj: obj as Record<string, unknown>, msg }),
			error: (obj, msg) => lines.push({ level: "error", obj: obj as Record<string, unknown>, msg }),
		},
	};
}

describe("loadEventStreamLimitsFromEnv", () => {
	test("defaults with an empty env", () => {
		expect(loadEventStreamLimitsFromEnv({})).toEqual({
			maxGlobal: DEFAULT_MAX_EVENT_STREAMS,
			maxPerClient: DEFAULT_MAX_EVENT_STREAMS_PER_CLIENT,
			maxLifetimeMs: DEFAULT_EVENT_STREAM_MAX_LIFETIME_MS,
			trustedProxyHops: DEFAULT_EVENT_STREAM_TRUSTED_PROXY_HOPS,
		});
	});

	test("the lifetime cap is ON by default (warren-3995)", () => {
		// The UI resumes via `since` on a lifetime close, so a default-on cap
		// no longer kills live tails — regressing this to 0 silently reopens
		// the wedged-client slot leak.
		expect(DEFAULT_EVENT_STREAM_MAX_LIFETIME_MS).toBeGreaterThan(0);
		expect(loadEventStreamLimitsFromEnv({}).maxLifetimeMs).toBe(
			DEFAULT_EVENT_STREAM_MAX_LIFETIME_MS,
		);
	});

	test("reads all three knobs", () => {
		expect(
			loadEventStreamLimitsFromEnv({
				WARREN_MAX_EVENT_STREAMS: "12",
				WARREN_MAX_EVENT_STREAMS_PER_CLIENT: "3",
				WARREN_EVENT_STREAM_MAX_LIFETIME: "90m",
				WARREN_EVENT_STREAM_TRUSTED_PROXY_HOPS: "1",
			}),
		).toEqual({ maxGlobal: 12, maxPerClient: 3, maxLifetimeMs: 90 * 60_000, trustedProxyHops: 1 });
	});

	test("0 disables a cap rather than failing", () => {
		const limits = loadEventStreamLimitsFromEnv({
			WARREN_MAX_EVENT_STREAMS: "0",
			WARREN_EVENT_STREAM_MAX_LIFETIME: "0",
		});
		expect(limits.maxGlobal).toBe(0);
		expect(limits.maxLifetimeMs).toBe(0);
	});

	test("blank is treated as unset", () => {
		expect(loadEventStreamLimitsFromEnv({ WARREN_MAX_EVENT_STREAMS: "  " }).maxGlobal).toBe(
			DEFAULT_MAX_EVENT_STREAMS,
		);
	});

	test("a malformed count fails loudly, naming the variable", () => {
		expect(() => loadEventStreamLimitsFromEnv({ WARREN_MAX_EVENT_STREAMS: "lots" })).toThrow(
			EventStreamConfigError,
		);
		expect(() =>
			loadEventStreamLimitsFromEnv({ WARREN_MAX_EVENT_STREAMS_PER_CLIENT: "-1" }),
		).toThrow(/WARREN_MAX_EVENT_STREAMS_PER_CLIENT/);
	});

	test("a malformed duration fails loudly", () => {
		expect(() =>
			loadEventStreamLimitsFromEnv({ WARREN_EVENT_STREAM_MAX_LIFETIME: "4 hours" }),
		).toThrow(/WARREN_EVENT_STREAM_MAX_LIFETIME/);
	});
});

describe("EventStreamLimiter", () => {
	test("admits up to the per-client cap, then refuses with scope 'client'", () => {
		const l = limiter({ maxPerClient: 2 });
		l.acquire("1.2.3.4");
		l.acquire("1.2.3.4");
		expect(l.activeFor("1.2.3.4")).toBe(2);
		try {
			l.acquire("1.2.3.4");
			throw new Error("expected a capacity rejection");
		} catch (err) {
			expect(err).toBeInstanceOf(EventStreamCapacityError);
			expect((err as EventStreamCapacityError).scope).toBe("client");
			expect((err as EventStreamCapacityError).retryAfterSeconds).toBe(
				EVENT_STREAM_RETRY_AFTER_SECONDS,
			);
		}
	});

	test("one client at its cap does not block a different client", () => {
		const l = limiter({ maxPerClient: 1 });
		l.acquire("1.2.3.4");
		expect(() => l.acquire("1.2.3.4")).toThrow(EventStreamCapacityError);
		expect(() => l.acquire("5.6.7.8")).not.toThrow();
		expect(l.active()).toBe(2);
	});

	test("the global cap refuses a client that is under its own allowance", () => {
		const l = limiter({ maxGlobal: 2, maxPerClient: 5 });
		l.acquire("a");
		l.acquire("b");
		try {
			l.acquire("c");
			throw new Error("expected a capacity rejection");
		} catch (err) {
			expect((err as EventStreamCapacityError).scope).toBe("global");
		}
	});

	test("the per-client cap is checked first so the rejection names the offender", () => {
		const l = limiter({ maxGlobal: 1, maxPerClient: 1 });
		l.acquire("noisy");
		try {
			l.acquire("noisy");
			throw new Error("expected a capacity rejection");
		} catch (err) {
			expect((err as EventStreamCapacityError).scope).toBe("client");
		}
	});

	test("a released slot frees capacity for both counters", () => {
		const l = limiter({ maxGlobal: 1, maxPerClient: 1 });
		const slot = l.acquire("a");
		expect(() => l.acquire("b")).toThrow(EventStreamCapacityError);
		slot.release();
		expect(l.active()).toBe(0);
		expect(l.activeFor("a")).toBe(0);
		expect(() => l.acquire("b")).not.toThrow();
	});

	test("release is idempotent — every teardown path may call it", () => {
		const l = limiter({ maxGlobal: 2 });
		const slot = l.acquire("a");
		slot.release();
		slot.release();
		slot.release();
		expect(l.active()).toBe(0);
		expect(l.activeFor("a")).toBe(0);
	});

	test("a caps-disabled limiter admits without bound", () => {
		const l = limiter();
		for (let i = 0; i < 50; i += 1) l.acquire("same");
		expect(l.active()).toBe(50);
	});

	test("the lifetime cap fires onExpire once the budget elapses", async () => {
		const l = limiter({ maxLifetimeMs: 5 });
		let expired = false;
		l.acquire("a", { onExpire: () => (expired = true) });
		await Bun.sleep(30);
		expect(expired).toBe(true);
	});

	test("releasing before the budget elapses cancels the expiry", async () => {
		const l = limiter({ maxLifetimeMs: 5 });
		let expired = false;
		const slot = l.acquire("a", { onExpire: () => (expired = true) });
		slot.release();
		await Bun.sleep(30);
		expect(expired).toBe(false);
	});

	test("no lifetime cap configured means no expiry timer", async () => {
		const l = limiter();
		let expired = false;
		l.acquire("a", { onExpire: () => (expired = true) });
		await Bun.sleep(20);
		expect(expired).toBe(false);
	});
});

describe("eventStreamClientKey", () => {
	test("ignores client-supplied left-most hops and trusts only the right-hand side (warren-46a7)", () => {
		// GCLB appends `<client-ip>, <lb-ip>` after whatever the caller sent,
		// so the left-most hop is attacker-controlled and must never key the cap.
		const ctx = ctxFor({
			headers: { "x-forwarded-for": "203.0.113.7, 198.51.100.4, 10.0.0.2" },
			clientIp: "10.0.0.9",
		});
		expect(eventStreamClientKey(ctx, 1)).toBe("198.51.100.4");
		expect(eventStreamClientKey(ctx, 0)).toBe("10.0.0.2");
	});

	test("a forged left-most rotation collapses to one key under the GCLB hop count", () => {
		const ctxForSpoof = (spoof: string): RouteContext =>
			ctxFor({
				headers: { "x-forwarded-for": `${spoof}, 198.51.100.4, 10.0.0.2` },
				clientIp: "10.0.0.9",
			});
		const keys = new Set(
			["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((spoof) => eventStreamClientKey(ctxForSpoof(spoof), 1)),
		);
		expect(keys).toEqual(new Set(["198.51.100.4"]));
	});

	test("a chain shorter than the trusted-hop count falls back to the socket peer", () => {
		const ctx = ctxFor({
			headers: { "x-forwarded-for": "203.0.113.7" },
			clientIp: "10.0.0.9",
		});
		expect(eventStreamClientKey(ctx, 1)).toBe("10.0.0.9");
	});

	test("falls back to the socket peer when there is no proxy header", () => {
		expect(eventStreamClientKey(ctxFor({ clientIp: "198.51.100.4" }))).toBe("198.51.100.4");
	});

	test("falls back to a shared bucket when neither is available", () => {
		expect(eventStreamClientKey(ctxFor())).toBe("unknown");
		expect(eventStreamClientKey(ctxFor({ headers: { "x-forwarded-for": " " } }))).toBe("unknown");
	});
});

describe("reserveEventStreamSlot", () => {
	test("no limiter wired ⇒ uncapped, with a no-op release", () => {
		const slot = reserveEventStreamSlot({
			limiter: undefined,
			ctx: ctxFor(),
			ctrl: new AbortController(),
			route: "GET /runs/:id/events",
		});
		expect(() => slot.release()).not.toThrow();
	});

	test("logs a client rejection at info, an instance rejection at warn", () => {
		const clientRec = recordingLogger();
		const clientLimiter = limiter({ maxPerClient: 1 });
		const reserve = (l: EventStreamLimiter, logger: Logger): void => {
			reserveEventStreamSlot({
				limiter: l,
				ctx: ctxFor({ clientIp: "1.2.3.4", logger }),
				ctrl: new AbortController(),
				route: "GET /runs/:id/events",
			});
		};

		reserve(clientLimiter, clientRec.logger);
		expect(() => reserve(clientLimiter, clientRec.logger)).toThrow(EventStreamCapacityError);
		expect(clientRec.lines).toHaveLength(1);
		expect(clientRec.lines[0]?.level).toBe("info");
		expect(clientRec.lines[0]?.obj).toMatchObject({
			route: "GET /runs/:id/events",
			scope: "client",
			client: "1.2.3.4",
			client_streams: 1,
			active_streams: 1,
		});

		const globalRec = recordingLogger();
		const globalLimiter = limiter({ maxGlobal: 1, maxPerClient: 10 });
		reserve(globalLimiter, globalRec.logger);
		expect(() => reserve(globalLimiter, globalRec.logger)).toThrow(EventStreamCapacityError);
		expect(globalRec.lines[0]?.level).toBe("warn");
		expect(globalRec.lines[0]?.obj).toMatchObject({ scope: "global" });
	});

	test("lifetime expiry aborts the caller's stream controller", async () => {
		const ctrl = new AbortController();
		reserveEventStreamSlot({
			limiter: limiter({ maxLifetimeMs: 5 }),
			ctx: ctxFor({ clientIp: "1.2.3.4" }),
			ctrl,
			route: "GET /runs/:id/events",
		});
		await Bun.sleep(30);
		expect(ctrl.signal.aborted).toBe(true);
	});
});

describe("renderError — event-stream capacity", () => {
	test("renders 503 with a Retry-After header", () => {
		const rendered = renderError(
			new EventStreamCapacityError("at capacity", {
				scope: "global",
				retryAfterSeconds: EVENT_STREAM_RETRY_AFTER_SECONDS,
				recoveryHint: "retry shortly",
			}),
		);
		expect(rendered.status).toBe(503);
		expect(rendered.headers?.["Retry-After"]).toBe(String(EVENT_STREAM_RETRY_AFTER_SECONDS));
		expect(rendered.envelope.error.code).toBe("event_stream_capacity");
		expect(rendered.envelope.error.hint).toBe("retry shortly");
	});

	test("a config error is an ordinary 500-family WarrenError, not a 503", () => {
		expect(renderError(new EventStreamConfigError("bad knob")).headers).toBeUndefined();
	});
});
