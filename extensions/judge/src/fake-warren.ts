/**
 * A stateful fake warren server for tests: serves `GET /runs`,
 * `GET /runs/:id`, and `GET /runs/:id/events` from in-memory tables,
 * exactly per the observed wire contract (bearer-gated, `?limit`/`?offset`
 * runs paging sorted `started desc`, the `{run: {...}}` detail envelope,
 * exclusive `?since`, bounded `?limit` event pages).
 *
 * Built from the docs and from the handler source the way a third party
 * would — any drift between this fake and real warren is itself friction
 * to file.
 */

import type { RunDetail, RunEvent, RunState } from "./warren-wire.ts";

export interface FakeRun {
	readonly id: string;
	readonly state: RunState;
	/** ISO string; the list sorts `started desc`. */
	readonly startedAt: string;
	/** Detail facts served by `GET /runs/:id`; sensible defaults apply. */
	readonly detail?: Partial<Omit<RunDetail, "id" | "state" | "startedAt">>;
}

export class FakeWarren {
	readonly runs: FakeRun[] = [];
	readonly events = new Map<string, RunEvent[]>();
	/** Request counts by route label, for fan-out assertions. */
	readonly requestCounts = new Map<string, number>();
	/** When set, every request fails with this status — chaos knob. */
	failWithStatus: number | null = null;
	/** The authorization header of the most recent request. */
	lastAuthorization: string | null = null;

	#server: ReturnType<typeof Bun.serve> | null = null;

	get baseUrl(): string {
		if (this.#server === null) throw new Error("fake warren not started");
		return `http://127.0.0.1:${this.#server.port}`;
	}

	addRun(run: FakeRun): void {
		this.runs.push(run);
		this.runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	}

	/** Transition a run's state (queued → running → terminal). */
	setRunState(runId: string, state: RunState): void {
		const run = this.runs.find((r) => r.id === runId);
		if (run === undefined) throw new Error(`no such run: ${runId}`);
		this.runs[this.runs.indexOf(run)] = { ...run, state };
	}

	addEvent(runId: string, event: Omit<RunEvent, "runId">): void {
		const list = this.events.get(runId) ?? [];
		list.push({ ...event, runId });
		list.sort((a, b) => a.seq - b.seq);
		this.events.set(runId, list);
	}

	#count(label: string): void {
		this.requestCounts.set(label, (this.requestCounts.get(label) ?? 0) + 1);
	}

	start(): void {
		this.#server = Bun.serve({
			port: 0,
			fetch: (req) => this.#handle(req),
		});
	}

	stop(): void {
		this.#server?.stop(true);
		this.#server = null;
	}

	#handle(req: Request): Response {
		const url = new URL(req.url);
		this.lastAuthorization = req.headers.get("authorization");
		if (this.failWithStatus !== null) {
			return Response.json({ error: "chaos" }, { status: this.failWithStatus });
		}
		if (url.pathname === "/runs") {
			return this.#handleList(url);
		}
		const eventsMatch = /^\/runs\/([^/]+)\/events$/.exec(url.pathname);
		if (eventsMatch !== null) {
			return this.#handleEvents(url, decodeURIComponent(eventsMatch[1] ?? ""));
		}
		const runMatch = /^\/runs\/([^/]+)$/.exec(url.pathname);
		if (runMatch !== null) {
			return this.#handleDetail(decodeURIComponent(runMatch[1] ?? ""));
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}

	#handleList(url: URL): Response {
		this.#count("GET /runs");
		const limit = Number(url.searchParams.get("limit") ?? "100");
		const offset = Number(url.searchParams.get("offset") ?? "0");
		const page = this.runs.slice(offset, offset + limit);
		return Response.json({
			runs: page.map((r) => ({
				id: r.id,
				state: r.state,
				startedAt: r.startedAt,
				// Extra fields a real row carries — the judge must ignore them.
				projectId: "proj-1",
				agentName: "pi",
			})),
			total: this.runs.length,
			limit,
			offset,
		});
	}

	#handleDetail(runId: string): Response {
		this.#count("GET /runs/:id");
		const run = this.runs.find((r) => r.id === runId);
		if (run === undefined) {
			return Response.json({ error: "run not found" }, { status: 404 });
		}
		// warren-7d84: the detail GET wraps the resource as {run: {...}},
		// matching POST /runs. Fields not set on the fake default to null,
		// the schema's "none / unknown" encoding.
		return Response.json({
			run: {
				id: run.id,
				state: run.state,
				startedAt: run.startedAt,
				failureReason: run.detail?.failureReason ?? null,
				costUsd: run.detail?.costUsd ?? null,
				prUrl: run.detail?.prUrl ?? null,
				prState: run.detail?.prState ?? null,
				prMergedAt: run.detail?.prMergedAt ?? null,
				endedAt: run.detail?.endedAt ?? null,
				// Extra operator-only fields the judge must ignore.
				prompt: "do the thing",
				renderedAgentJson: "{}",
			},
		});
	}

	#handleEvents(url: URL, runId: string): Response {
		this.#count("GET /runs/:id/events");
		if (!this.runs.some((r) => r.id === runId)) {
			return Response.json({ error: "run not found" }, { status: 404 });
		}
		const since = Number(url.searchParams.get("since") ?? "0");
		const limit = Number(url.searchParams.get("limit") ?? "100");
		const page = (this.events.get(runId) ?? [])
			.filter((e) => e.seq > since)
			.slice(0, limit);
		const body = page.map((e) => JSON.stringify(e)).join("\n") + (page.length > 0 ? "\n" : "");
		return new Response(body, {
			headers: { "content-type": "application/x-ndjson" },
		});
	}
}
