import { describe, expect, test } from "bun:test";
import { LifecycleStreamBroker } from "../../runs/lifecycle-stream.ts";
import type { RouteContext, ServerDeps } from "../types.ts";
import { streamLifecycleEventsHandler } from "./events-stream.ts";

function ctxFor(url: string): RouteContext {
	return {
		request: new Request(url),
		url: new URL(url),
		params: {},
		requestId: "req-test",
		logger: {
			info() {},
			warn() {},
			error() {},
		},
	};
}

const BASE = "http://127.0.0.1:8377";

function depsFor(lifecycleStream?: LifecycleStreamBroker): ServerDeps {
	return { lifecycleStream } as unknown as ServerDeps;
}

async function readLine(body: ReadableStream<Uint8Array>): Promise<string> {
	const reader = body.getReader();
	const { value } = await reader.read();
	await reader.cancel();
	return new TextDecoder().decode(value);
}

describe("streamLifecycleEventsHandler", () => {
	test("501s when the broker seam is not wired", async () => {
		const res = await streamLifecycleEventsHandler(depsFor())(ctxFor(`${BASE}/events/stream`));
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_implemented");
	});

	test("?follow=0 closes immediately with an empty body", async () => {
		const broker = new LifecycleStreamBroker();
		const res = await streamLifecycleEventsHandler(depsFor(broker))(
			ctxFor(`${BASE}/events/stream?follow=0`),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/x-ndjson");
		expect(await res.text()).toBe("");
		expect(broker.subscriberCount()).toBe(0);
	});

	test("streams one NDJSON line per published notification", async () => {
		const broker = new LifecycleStreamBroker();
		const res = await streamLifecycleEventsHandler(depsFor(broker))(
			ctxFor(`${BASE}/events/stream?follow=1`),
		);
		expect(res.status).toBe(200);
		expect(broker.subscriberCount()).toBe(1);

		broker.publish({ runId: "r1", hook: "run_started", state: "running", ts: "t" });
		const line = await readLine(res.body as ReadableStream<Uint8Array>);
		expect(JSON.parse(line)).toEqual({
			runId: "r1",
			hook: "run_started",
			state: "running",
			ts: "t",
		});
	});
});
