/**
 * The Azure DevOps Boards REST 7.1 client.
 *
 * Every call goes through {@link AdoClient.request}, so the credential is
 * attached in one place and an upstream failure becomes one error type
 * carrying the status. `fetchImpl` is the seam the tests drive with
 * recorded Azure DevOps payloads.
 *
 * Every 2xx body is checked for the shape the caller reads before it
 * leaves this module. A proxy or a changed API that answers 200 with
 * something else surfaces as a 502 here, not as an empty status or a
 * TypeError three layers up.
 *
 * No retries live here. Warren's bridge already retries 429 and 5xx with
 * backoff that honors `Retry-After` (docs/design/issue-tracker.md §5), so
 * this server passes the upstream's answer up rather than growing a
 * second, unsynchronized backoff underneath the first.
 */

import { type AdoTrackerConfig, adoAuthHeader } from "../config.ts";
import { ADO_API_VERSION, type AdoWorkItem, type AdoWorkItemTypeState } from "./types.ts";

/** A non-2xx or unreachable Azure DevOps. `status` is 0 when the call never landed. */
export class AdoApiError extends Error {
	readonly status: number;
	readonly retryAfter: string | null;

	constructor(message: string, status: number, retryAfter: string | null = null) {
		super(message);
		this.name = "AdoApiError";
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

/** Azure DevOps did not finish answering within `timeoutMs`. */
export class AdoTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdoTimeoutError";
	}
}

/**
 * The configured WIQL selected more than `maxWiqlResults` work items.
 * Azure DevOps answered fine; the configuration is what is wrong, and it
 * stays wrong on a retry, so this is deliberately not an {@link AdoApiError}.
 */
export class AdoQueryTooBroadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdoQueryTooBroadError";
	}
}

const STATE_FIELD = "System.State";
const TYPE_FIELD = "System.WorkItemType";
/** What the status map needs: the state, and the type whose process defines it. */
const STATUS_FIELDS = [STATE_FIELD, TYPE_FIELD];

export class AdoClient {
	private readonly config: AdoTrackerConfig;
	private readonly fetchImpl: typeof fetch;
	/**
	 * States per work item type, for the life of the process. A process
	 * template changes when an admin edits it, which is rare enough that
	 * a restart is the refresh.
	 */
	private readonly statesByType = new Map<string, readonly AdoWorkItemTypeState[]>();

	constructor(config: AdoTrackerConfig, fetchImpl: typeof fetch = fetch) {
		this.config = config;
		this.fetchImpl = fetchImpl;
	}

	/** Reads the work item with its relations, which is how blockers arrive. */
	async getWorkItem(id: number): Promise<AdoWorkItem> {
		const path = this.witPath(`/workitems/${id}`, { $expand: "relations" });
		return requireWorkItem(await this.request("GET", path), `GET ${path}`);
	}

	/**
	 * Every work item the configured WIQL selects, with its state and its
	 * type only. WIQL answers with ids, so the fields come from a batch
	 * read afterwards, at most 200 ids per call.
	 *
	 * `maxWiqlResults` is the backstop against a query that selects the
	 * whole project. The query asks for one more than the cap, and a
	 * result past the cap throws rather than truncating: a silently short
	 * status map would read to warren as issues that vanished.
	 */
	async queryWorkItems(): Promise<AdoWorkItem[]> {
		const ids = await this.queryIds();
		const items: AdoWorkItem[] = [];
		for (let start = 0; start < ids.length; start += this.config.batchSize) {
			const chunk = ids.slice(start, start + this.config.batchSize);
			const path = this.witPath("/workitemsbatch");
			const what = `POST ${path}`;
			const body = requireObject(
				await this.request("POST", path, { ids: chunk, fields: STATUS_FIELDS }),
				what,
			);
			for (const entry of requireArray(body.value, what, "value")) {
				items.push(requireWorkItem(entry, what));
			}
		}
		return items;
	}

	/**
	 * Only a flat query answers with a plain list of ids. A tree or
	 * one-hop query answers with `workItemRelations` instead, which this
	 * client does not read, so it refuses rather than reporting nothing.
	 */
	private async queryIds(): Promise<number[]> {
		const limit = this.config.maxWiqlResults;
		const path = this.witPath("/wiql", { $top: String(limit + 1) });
		const what = `POST ${path}`;
		const body = requireObject(await this.request("POST", path, { query: this.config.wiql }), what);
		if (body.queryType !== "flat") {
			throw new AdoApiError(
				`azure devops ${what} answered a "${String(body.queryType)}" query; ADO_WIQL must be a flat query`,
				502,
			);
		}
		const ids: number[] = [];
		for (const ref of requireArray(body.workItems, what, "workItems")) {
			const id = requireObject(ref, what).id;
			if (typeof id !== "number") throw malformed(what, "a workItems entry without a numeric id");
			ids.push(id);
		}
		if (ids.length > limit) {
			throw new AdoQueryTooBroadError(
				`the configured WIQL selected more than ${limit} work items; narrow it or raise ADO_MAX_WIQL_RESULTS`,
			);
		}
		return ids;
	}

	/** The states a work item type's process defines, with their categories. */
	async states(workItemType: string): Promise<readonly AdoWorkItemTypeState[]> {
		const cached = this.statesByType.get(workItemType);
		if (cached !== undefined) return cached;
		const path = this.witPath(`/workitemtypes/${encodeURIComponent(workItemType)}/states`);
		const what = `GET ${path}`;
		const body = requireObject(await this.request("GET", path), what);
		const states = requireArray(body.value, what, "value").map((entry) =>
			requireObject(entry, what),
		) as AdoWorkItemTypeState[];
		this.statesByType.set(workItemType, states);
		return states;
	}

	/**
	 * Moves the work item to `state` and returns it as Azure DevOps now
	 * holds it. The patch names the revision it was decided against, so a
	 * work item edited in between answers with a conflict rather than
	 * taking a state change based on a view that is no longer true.
	 */
	async setState(item: AdoWorkItem, state: string): Promise<AdoWorkItem> {
		const path = this.witPath(`/workitems/${item.id}`);
		const patch = [
			{ op: "test", path: "/rev", value: item.rev },
			{ op: "add", path: `/fields/${STATE_FIELD}`, value: state },
		];
		return requireWorkItem(
			await this.request("PATCH", path, patch, "application/json-patch+json"),
			`PATCH ${path}`,
		);
	}

	private witPath(suffix: string, query: Record<string, string> = {}): string {
		const params = new URLSearchParams({ ...query, "api-version": ADO_API_VERSION });
		return `/${encodeURIComponent(this.config.project)}/_apis/wit${suffix}?${params}`;
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
		contentType = "application/json",
	): Promise<unknown> {
		const headers: Record<string, string> = {
			accept: "application/json",
			authorization: adoAuthHeader(this.config.auth),
		};
		if (body !== undefined) headers["content-type"] = contentType;
		// One deadline covers the connection, the headers and the body: a
		// stalled body read hangs a handler just as well as a stalled
		// connect, and warren's retry cannot begin until this call ends.
		// An explicit timer rather than `AbortSignal.timeout`: that signal
		// does not keep Bun's event loop alive on every platform, so a
		// pending fetch can outlive the deadline it was supposed to cut.
		const controller = new AbortController();
		const deadline = setTimeout(
			() => controller.abort(new DOMException("deadline passed", "TimeoutError")),
			this.config.timeoutMs,
		);
		try {
			return await this.exchange(method, path, headers, body, controller.signal);
		} finally {
			clearTimeout(deadline);
		}
	}

	private async exchange(
		method: string,
		path: string,
		headers: Record<string, string>,
		body: unknown,
		signal: AbortSignal,
	): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.config.orgUrl}${path}`, {
				method,
				headers,
				signal,
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			});
		} catch (err) {
			throw this.transportFailure(err, `${method} ${path}`);
		}
		// A rejected or missing credential comes back as 203 with the
		// sign-in page rather than as a 401, so a 2xx that is not JSON is
		// read as a credential failure below rather than as a parse error.
		if (!response.ok || response.status === 203) {
			throw new AdoApiError(
				`azure devops ${method} ${path} failed: ${response.status} ${await errorText(response)}`,
				response.status,
				response.headers.get("retry-after"),
			);
		}
		if (response.status === 204) return undefined;
		let text: string;
		try {
			text = await response.text();
		} catch (err) {
			throw this.transportFailure(err, `${method} ${path}`);
		}
		if (text.trim() === "") return undefined;
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new AdoApiError(`azure devops ${method} ${path} returned a body that is not JSON`, 502);
		}
	}

	/** A call that never produced an answer: the deadline passed, or the network failed. */
	private transportFailure(err: unknown, what: string): Error {
		if (isTimeout(err)) {
			return new AdoTimeoutError(
				`azure devops ${what} did not answer within ${this.config.timeoutMs}ms`,
			);
		}
		const reason = err instanceof Error ? err.message : String(err);
		return new AdoApiError(`azure devops unreachable: ${reason}`, 0);
	}
}

/** What `fetch` rejects with when the deadline aborts the request. */
function isTimeout(err: unknown): boolean {
	return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function malformed(what: string, problem: string): AdoApiError {
	return new AdoApiError(`azure devops ${what} answered 2xx with ${problem}`, 502);
}

/**
 * A 2xx that carried no object. Every call this client makes expects one,
 * so a proxy answering 200 with an empty body surfaces as the upstream
 * problem it is rather than reaching the mapping as `undefined`.
 */
function requireObject(body: unknown, what: string): Record<string, unknown> {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw malformed(what, "no object");
	}
	return body as Record<string, unknown>;
}

function requireArray(value: unknown, what: string, field: string): unknown[] {
	if (!Array.isArray(value)) throw malformed(what, `no "${field}" array`);
	return value;
}

/**
 * A work item is one only with the id, revision and state every
 * operation reads. The other fields stay optional, because a process
 * template decides which of them exist.
 */
function requireWorkItem(body: unknown, what: string): AdoWorkItem {
	const item = requireObject(body, what);
	const fields = item.fields;
	const state =
		fields !== null && typeof fields === "object"
			? (fields as Record<string, unknown>)[STATE_FIELD]
			: undefined;
	if (typeof item.id !== "number" || typeof item.rev !== "number" || typeof state !== "string") {
		throw malformed(what, `a work item without a numeric id, a rev and a ${STATE_FIELD}`);
	}
	return item as unknown as AdoWorkItem;
}

/**
 * Azure DevOps error bodies are JSON with a `message` most of the time
 * and an HTML sign-in page the rest of the time, so the text is only ever
 * a diagnostic string. An HTML page reduces to its title, because the
 * markup says nothing and the title ("Azure DevOps Services | Sign In")
 * says everything. It is bounded because it lands in this server's logs
 * and in the message warren surfaces.
 */
async function errorText(response: Response): Promise<string> {
	try {
		const text = await response.text();
		try {
			const parsed = JSON.parse(text) as { message?: unknown };
			if (typeof parsed.message === "string") return parsed.message.slice(0, 300);
		} catch {
			// Not JSON; fall through to the raw text.
		}
		const title = /<title>([\s\S]*?)<\/title>/i.exec(text);
		if (title?.[1] !== undefined) return `html page "${title[1].replace(/\s+/g, " ").trim()}"`;
		if (/^\s*<(!doctype|html)/i.test(text)) return "html page";
		return text.slice(0, 300);
	} catch {
		return "<unreadable body>";
	}
}
