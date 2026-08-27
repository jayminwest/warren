import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RouteContext } from "../types.ts";
import { judgeVerdictsProxyHandler } from "./judge-proxy.ts";

const silentLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

function makeCtx(pathAndQuery: string): RouteContext {
	const url = new URL(`http://warren.local${pathAndQuery}`);
	return {
		request: new Request(url),
		url,
		params: {},
		logger: silentLogger,
		requestId: "test-req",
	};
}

const UPSTREAM_BODY = '{"id":1,"verdict":"pass"}\n{"id":2,"verdict":"fail"}\n';

describe("judgeVerdictsProxyHandler", () => {
	let savedBaseUrl: string | undefined;
	let savedToken: string | undefined;
	let upstream: ReturnType<typeof Bun.serve> | undefined;

	beforeEach(() => {
		savedBaseUrl = process.env.WARREN_JUDGE_BASE_URL;
		savedToken = process.env.WARREN_JUDGE_EXPORT_TOKEN;
	});

	afterEach(() => {
		if (savedBaseUrl === undefined) delete process.env.WARREN_JUDGE_BASE_URL;
		else process.env.WARREN_JUDGE_BASE_URL = savedBaseUrl;
		if (savedToken === undefined) delete process.env.WARREN_JUDGE_EXPORT_TOKEN;
		else process.env.WARREN_JUDGE_EXPORT_TOKEN = savedToken;
		upstream?.stop(true);
		upstream = undefined;
	});

	test("answers 501 judge_not_configured when env is unset", async () => {
		delete process.env.WARREN_JUDGE_BASE_URL;
		delete process.env.WARREN_JUDGE_EXPORT_TOKEN;
		const res = await judgeVerdictsProxyHandler()(makeCtx("/extensions/judge/verdicts.jsonl"));
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("judge_not_configured");
	});

	test("proxies the upstream export, forwarding query params and the cursor header", async () => {
		let seenAuth = "";
		let seenQuery = "";
		upstream = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				seenAuth = req.headers.get("authorization") ?? "";
				seenQuery = url.search;
				return new Response(UPSTREAM_BODY, {
					headers: { "content-type": "application/x-ndjson", "x-verdicts-max-id": "2" },
				});
			},
		});
		process.env.WARREN_JUDGE_BASE_URL = `http://localhost:${upstream.port}`;
		process.env.WARREN_JUDGE_EXPORT_TOKEN = "judge-export-secret";
		const res = await judgeVerdictsProxyHandler()(
			makeCtx("/extensions/judge/verdicts.jsonl?since=1&limit=50"),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(UPSTREAM_BODY);
		expect(res.headers.get("content-type")).toBe("application/x-ndjson");
		expect(res.headers.get("x-verdicts-max-id")).toBe("2");
		expect(seenAuth).toBe("Bearer judge-export-secret");
		expect(seenQuery).toBe("?since=1&limit=50");
	});

	test("answers 502 judge_export_failed on an upstream non-200 status", async () => {
		upstream = Bun.serve({
			port: 0,
			fetch: () => new Response("unauthorized", { status: 401 }),
		});
		process.env.WARREN_JUDGE_BASE_URL = `http://localhost:${upstream.port}`;
		process.env.WARREN_JUDGE_EXPORT_TOKEN = "judge-export-secret";
		const res = await judgeVerdictsProxyHandler()(makeCtx("/extensions/judge/verdicts.jsonl"));
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("judge_export_failed");
	});

	test("answers 502 judge_unreachable when the upstream is down", async () => {
		// Bind then immediately stop to get a very likely-free port.
		const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
		const port = probe.port;
		probe.stop(true);
		process.env.WARREN_JUDGE_BASE_URL = `http://localhost:${port}`;
		process.env.WARREN_JUDGE_EXPORT_TOKEN = "judge-export-secret";
		const res = await judgeVerdictsProxyHandler()(makeCtx("/extensions/judge/verdicts.jsonl"));
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("judge_unreachable");
	});
});
