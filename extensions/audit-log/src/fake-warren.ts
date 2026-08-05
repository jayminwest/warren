/**
 * A stateful fake warren server for tests: serves `GET /runs` and
 * `GET /runs/:id/events` from in-memory tables, exactly per the observed
 * wire contract (bearer-gated, `?limit`/`?offset` runs paging sorted
 * `started desc`, exclusive `?since`, bounded `?limit` event pages).
 *
 * Built from the docs and from the handler source the way a third party
 * would — any drift between this fake and real warren is itself friction
 * to file (plan risk 4).
 */

import type { RunEvent } from "./wire.ts";

export interface FakeRun {
	readonly id: string;
	readonly state: string;
	/** ISO string; the list sorts `started desc`. */
	readonly startedAt: string;
}

export class FakeWarren {
	readonly runs: FakeRun[] = [];
	readonly events = new Map<string, RunEvent[]>();
	/** Request counts by route label, for fan-out assertions. */
	readonly requestCounts = new Map<string, number>();
	/** When set, every request fails with this status — chaos knob. */
	failWithStatus: number | null = null;
	/** When true, requests arrive with no/invalid bearer — auth assertions. */
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

	/** Transition a run's list state (queued → running → terminal). */
	setRunState(runId: string, state: string): void {
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
			this.#count("GET /runs");
			const limit = Number(url.searchParams.get("limit") ?? "100");
			const offset = Number(url.searchParams.get("offset") ?? "0");
			const page = this.runs.slice(offset, offset + limit);
			return Response.json({
				runs: page.map((r) => ({
					id: r.id,
					state: r.state,
					startedAt: r.startedAt,
					// Extra fields a real row carries — the collector must ignore them.
					projectId: "proj-1",
					costUsd: 0,
				})),
				total: this.runs.length,
				limit,
				offset,
			});
		}
		const eventsMatch = /^\/runs\/([^/]+)\/events$/.exec(url.pathname);
		if (eventsMatch !== null) {
			this.#count("GET /runs/:id/events");
			const runId = decodeURIComponent(eventsMatch[1] ?? "");
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
		return Response.json({ error: "not found" }, { status: 404 });
	}
}
