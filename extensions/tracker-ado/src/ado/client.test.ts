/**
 * The transport, driven directly rather than through the handler.
 *
 * The cases here are the ones the server tests cannot reach: what the
 * request actually carries to Azure DevOps, and how the client reads a
 * response that is not a plain JSON body. This is the layer most likely
 * to be wrong against a real organization, so it is worth pinning on its
 * own.
 */

import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config.ts";
import { json } from "../responses.ts";
import { AdoApiError, AdoClient, AdoQueryTooBroadError, AdoTimeoutError } from "./client.ts";

interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | undefined;
}

function recordingFetch(responder: (request: RecordedRequest) => Response): {
	fetchImpl: typeof fetch;
	requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
			headers[key.toLowerCase()] = value;
		}
		const record: RecordedRequest = {
			url: typeof input === "string" ? input : input.toString(),
			method: init?.method ?? "GET",
			headers,
			body: typeof init?.body === "string" ? init.body : undefined,
		};
		requests.push(record);
		return responder(record);
	}) as unknown as typeof fetch;
	return { fetchImpl, requests };
}

const BASE = {
	ADO_ORG_URL: "https://dev.azure.com/acme",
	ADO_PROJECT: "Team Project",
	ADO_PAT: "pat-123",
	ADO_WIQL: "SELECT [System.Id] FROM WorkItems",
};

function workItem(id: number, state = "New"): Response {
	return json({ id, rev: 3, fields: { "System.State": state } });
}

async function failureOf(run: (client: AdoClient) => Promise<unknown>, fetchImpl: typeof fetch) {
	const failure = await run(new AdoClient(loadConfig(BASE), fetchImpl)).catch(
		(err: unknown) => err,
	);
	expect(failure).toBeInstanceOf(AdoApiError);
	return failure as AdoApiError;
}

describe("AdoClient request shape", () => {
	test("sends basic auth with an empty user name and the token", async () => {
		const { fetchImpl, requests } = recordingFetch(() => workItem(1));
		await new AdoClient(loadConfig(BASE), fetchImpl).getWorkItem(1);
		expect(requests[0]?.headers.authorization).toBe(
			`Basic ${Buffer.from(":pat-123").toString("base64")}`,
		);
	});

	test("sends a bearer when that is how the container is configured", async () => {
		const { fetchImpl, requests } = recordingFetch(() => workItem(1));
		const config = loadConfig({ ...BASE, ADO_PAT: undefined, ADO_BEARER: "entra-abc" });
		await new AdoClient(config, fetchImpl).getWorkItem(1);
		expect(requests[0]?.headers.authorization).toBe("Bearer entra-abc");
	});

	test("scopes every route to the project, escaped, and pins the api version", async () => {
		const { fetchImpl, requests } = recordingFetch(() => workItem(42));
		await new AdoClient(loadConfig(BASE), fetchImpl).getWorkItem(42);
		expect(requests[0]?.url).toBe(
			"https://dev.azure.com/acme/Team%20Project/_apis/wit/workitems/42?%24expand=relations&api-version=7.1",
		);
	});

	test("moves state with a JSON patch document that names the revision it was decided on", async () => {
		const { fetchImpl, requests } = recordingFetch(() => workItem(42, "Closed"));
		const item = { id: 42, rev: 7, fields: { "System.State": "New" } };
		await new AdoClient(loadConfig(BASE), fetchImpl).setState(item, "Closed");
		expect(requests[0]?.method).toBe("PATCH");
		expect(requests[0]?.headers["content-type"]).toBe("application/json-patch+json");
		expect(JSON.parse(requests[0]?.body ?? "")).toEqual([
			{ op: "test", path: "/rev", value: 7 },
			{ op: "add", path: "/fields/System.State", value: "Closed" },
		]);
	});
});

describe("AdoClient deadline", () => {
	/** A transport that never answers on its own and only ends when the signal fires. */
	function stalledFetch(): { fetchImpl: typeof fetch; signals: AbortSignal[] } {
		const signals: AbortSignal[] = [];
		const fetchImpl = ((_input: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal === undefined || signal === null) return;
				signals.push(signal);
				signal.addEventListener("abort", () => reject(signal.reason));
			})) as unknown as typeof fetch;
		return { fetchImpl, signals };
	}

	test("hands every call a signal that fires at the configured deadline", async () => {
		const { fetchImpl, signals } = stalledFetch();
		const client = new AdoClient(loadConfig({ ...BASE, ADO_TIMEOUT_MS: "20" }), fetchImpl);
		const failure = await client.getWorkItem(1).catch((err: unknown) => err);
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(true);
		expect(failure).toBeInstanceOf(AdoTimeoutError);
		expect((failure as Error).message).toMatch(/GET .*workitems\/1.*within 20ms/);
	});

	test("reads a body that stalls past the deadline as the same timeout", async () => {
		const fetchImpl = ((_input: unknown, init?: RequestInit) => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
				},
			});
			return Promise.resolve(new Response(stream, { status: 200 }));
		}) as unknown as typeof fetch;
		const client = new AdoClient(loadConfig({ ...BASE, ADO_TIMEOUT_MS: "20" }), fetchImpl);
		const failure = await client.getWorkItem(1).catch((err: unknown) => err);
		expect(failure).toBeInstanceOf(AdoTimeoutError);
	});
});

describe("AdoClient.queryWorkItems", () => {
	test("queries ids with WIQL, then reads state and type in batches of the configured size", async () => {
		const { fetchImpl, requests } = recordingFetch((request) => {
			if (request.url.includes("/wiql")) {
				return json({ queryType: "flat", workItems: [{ id: 1 }, { id: 2 }, { id: 3 }] });
			}
			const ids = (JSON.parse(request.body ?? "{}") as { ids: number[] }).ids;
			return json({
				count: ids.length,
				value: ids.map((id) => ({
					id,
					rev: 1,
					fields: { "System.State": `S${id}`, "System.WorkItemType": "Bug" },
				})),
			});
		});
		const client = new AdoClient(loadConfig({ ...BASE, ADO_BATCH_SIZE: "2" }), fetchImpl);
		expect(await client.queryWorkItems()).toEqual([
			{ id: 1, rev: 1, fields: { "System.State": "S1", "System.WorkItemType": "Bug" } },
			{ id: 2, rev: 1, fields: { "System.State": "S2", "System.WorkItemType": "Bug" } },
			{ id: 3, rev: 1, fields: { "System.State": "S3", "System.WorkItemType": "Bug" } },
		]);
		expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
			"POST /acme/Team%20Project/_apis/wit/wiql",
			"POST /acme/Team%20Project/_apis/wit/workitemsbatch",
			"POST /acme/Team%20Project/_apis/wit/workitemsbatch",
		]);
		expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ query: BASE.ADO_WIQL });
		expect(JSON.parse(requests[1]?.body ?? "")).toEqual({
			ids: [1, 2],
			fields: ["System.State", "System.WorkItemType"],
		});
	});

	test("answers an empty list without a batch read when the query selects nothing", async () => {
		const { fetchImpl, requests } = recordingFetch(() =>
			json({ queryType: "flat", workItems: [] }),
		);
		expect(await new AdoClient(loadConfig(BASE), fetchImpl).queryWorkItems()).toEqual([]);
		expect(requests).toHaveLength(1);
	});

	test("asks for one past the cap and fails loud rather than truncating", async () => {
		const { fetchImpl, requests } = recordingFetch(() =>
			json({ queryType: "flat", workItems: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
		);
		const client = new AdoClient(loadConfig({ ...BASE, ADO_MAX_WIQL_RESULTS: "2" }), fetchImpl);
		const failure = await client.queryWorkItems().catch((err: unknown) => err);
		expect(failure).toBeInstanceOf(AdoQueryTooBroadError);
		expect((failure as Error).message).toMatch(/ADO_MAX_WIQL_RESULTS/);
		expect(new URL(requests[0]?.url ?? "").searchParams.get("$top")).toBe("3");
	});

	test("refuses a query that is not flat, because its answer carries no id list", async () => {
		const { fetchImpl, requests } = recordingFetch(() =>
			json({ queryType: "tree", workItemRelations: [{ target: { id: 1 } }] }),
		);
		const failure = await failureOf((client) => client.queryWorkItems(), fetchImpl);
		expect(failure.status).toBe(502);
		expect(failure.message).toContain('"tree"');
		expect(requests).toHaveLength(1);
	});
});

describe("AdoClient.states", () => {
	test("reads a type's states once and answers from memory after that", async () => {
		const { fetchImpl, requests } = recordingFetch(() =>
			json({ value: [{ name: "Done", category: "Completed" }] }),
		);
		const client = new AdoClient(loadConfig(BASE), fetchImpl);
		await client.states("User Story");
		expect(await client.states("User Story")).toEqual([{ name: "Done", category: "Completed" }]);
		expect(requests).toHaveLength(1);
		expect(new URL(requests[0]?.url ?? "").pathname).toBe(
			"/acme/Team%20Project/_apis/wit/workitemtypes/User%20Story/states",
		);
	});
});

describe("AdoClient response handling", () => {
	test("reads the message out of an Azure DevOps error body", async () => {
		const { fetchImpl } = recordingFetch(() =>
			json({ message: "TF401232: Work item 9 does not exist", typeKey: "X" }, 404),
		);
		const failure = await new AdoClient(loadConfig(BASE), fetchImpl)
			.getWorkItem(9)
			.catch((err: unknown) => err);
		expect(failure).toBeInstanceOf(AdoApiError);
		expect((failure as AdoApiError).status).toBe(404);
		expect((failure as AdoApiError).message).toContain("TF401232");
	});

	test("treats the 203 sign-in page as a failure carrying that status", async () => {
		const { fetchImpl } = recordingFetch(
			() =>
				new Response(
					'<!DOCTYPE html>\r\n<html lang="en-US">\r\n<head><title>\r\n\t\r\n  Azure DevOps Services | Sign In\r\n</title><meta charset="utf-8"></head><body>...</body></html>',
					{ status: 203, headers: { "content-type": "text/html" } },
				),
		);
		const failure = await new AdoClient(loadConfig(BASE), fetchImpl)
			.getWorkItem(9)
			.catch((err: unknown) => err);
		expect((failure as AdoApiError).status).toBe(203);
		expect((failure as AdoApiError).message).toEndWith(
			'failed: 203 html page "Azure DevOps Services | Sign In"',
		);
	});

	test("names an untitled html error body without quoting its markup", async () => {
		const { fetchImpl } = recordingFetch(
			() => new Response("<html><body>nope</body></html>", { status: 503 }),
		);
		const failure = await new AdoClient(loadConfig(BASE), fetchImpl)
			.getWorkItem(9)
			.catch((err: unknown) => err);
		expect((failure as AdoApiError).message).toEndWith("failed: 503 html page");
	});

	test("carries Retry-After off a rate limit", async () => {
		const { fetchImpl } = recordingFetch(
			() => new Response("{}", { status: 429, headers: { "retry-after": "12" } }),
		);
		const failure = await new AdoClient(loadConfig(BASE), fetchImpl)
			.getWorkItem(9)
			.catch((err: unknown) => err);
		expect((failure as AdoApiError).status).toBe(429);
		expect((failure as AdoApiError).retryAfter).toBe("12");
	});

	test("reports an unreachable organization with status 0", async () => {
		const fetchImpl = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const failure = await new AdoClient(loadConfig(BASE), fetchImpl)
			.getWorkItem(9)
			.catch((err: unknown) => err);
		expect((failure as AdoApiError).status).toBe(0);
		expect((failure as AdoApiError).message).toContain("ECONNREFUSED");
	});

	test("refuses a 2xx that carries no object", async () => {
		const { fetchImpl } = recordingFetch(() => new Response("", { status: 200 }));
		const failure = await new AdoClient(loadConfig(BASE), fetchImpl)
			.getWorkItem(9)
			.catch((err: unknown) => err);
		expect((failure as AdoApiError).status).toBe(502);
		expect((failure as AdoApiError).message).toContain("no object");
	});

	test("refuses a 2xx whose body is not JSON", async () => {
		const { fetchImpl } = recordingFetch(() => new Response("<html/>", { status: 200 }));
		const failure = await new AdoClient(loadConfig(BASE), fetchImpl)
			.getWorkItem(9)
			.catch((err: unknown) => err);
		expect((failure as AdoApiError).message).toContain("not JSON");
	});
});

describe("AdoClient malformed 2xx payloads", () => {
	const cases: [string, unknown, (client: AdoClient) => Promise<unknown>][] = [
		[
			"a work item without an id",
			{ rev: 1, fields: { "System.State": "New" } },
			(c) => c.getWorkItem(9),
		],
		[
			"a work item without a rev",
			{ id: 9, fields: { "System.State": "New" } },
			(c) => c.getWorkItem(9),
		],
		["a work item without a state", { id: 9, rev: 1, fields: {} }, (c) => c.getWorkItem(9)],
		[
			"a work item whose state is not text",
			{ id: 9, rev: 1, fields: { "System.State": 1 } },
			(c) => c.getWorkItem(9),
		],
		[
			"a patched item without a state",
			{ id: 9, rev: 2 },
			(c) => c.setState({ id: 9, rev: 1, fields: { "System.State": "New" } }, "Closed"),
		],
		["a query answer without workItems", { queryType: "flat" }, (c) => c.queryWorkItems()],
		[
			"a query answer whose workItems is not a list",
			{ queryType: "flat", workItems: {} },
			(c) => c.queryWorkItems(),
		],
		[
			"a query entry without an id",
			{ queryType: "flat", workItems: [{ url: "x" }] },
			(c) => c.queryWorkItems(),
		],
		["a states answer without value", { count: 0 }, (c) => c.states("Bug")],
		["a states answer whose value is not a list", { value: "Closed" }, (c) => c.states("Bug")],
		["a list where an object was expected", [], (c) => c.getWorkItem(9)],
	];

	for (const [name, body, run] of cases) {
		test(`answers 502 for ${name}`, async () => {
			const { fetchImpl } = recordingFetch(() => json(body));
			const failure = await failureOf(run, fetchImpl);
			expect(failure.status).toBe(502);
			expect(failure.message).toContain("answered 2xx with");
		});
	}

	test("answers 502 when a batch entry is not a work item", async () => {
		const { fetchImpl } = recordingFetch((request) =>
			request.url.includes("/wiql")
				? json({ queryType: "flat", workItems: [{ id: 1 }] })
				: json({ count: 1, value: [{ id: 1, rev: 1 }] }),
		);
		const failure = await failureOf((client) => client.queryWorkItems(), fetchImpl);
		expect(failure.status).toBe(502);
		expect(failure.message).toContain("System.State");
	});
});
