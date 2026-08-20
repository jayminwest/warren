/**
 * The warren-tracker/v1 conformance suite (warren-53ea) — the
 * falsification test for the protocol (docs/PHILOSOPHY.md rule 4).
 *
 * Run it against ANY server URL that claims to speak warren-tracker/v1:
 *
 *   bun run src/check.ts http://localhost:8080
 *
 * What it holds a server to:
 *
 *   - PROTOCOL-VERSION NEGOTIATION: `GET /capabilities` must report
 *     exactly `warren-tracker/v1`. A mismatch rejects the server
 *     outright — the same boot-time refusal warren's RemoteTracker
 *     performs — and the suite refuses to judge anything else.
 *   - BASE CONTRACT: issue reads, the raw `id → status` map, and an
 *     IDEMPOTENT close (closing twice is 2xx both times; the read views
 *     agree on the resulting raw status).
 *   - NOT-FOUND TAXONOMY: a missing issue id surfaces as a non-2xx
 *     response whose envelope carries `error.code: "issue_not_found"`,
 *     on both the read and the close path.
 *   - OPTIONAL SURFACES, GATED ON DECLARED CAPABILITIES: plans,
 *     metadata (shallow merge + null-clears), and scheduled issues are
 *     exercised only when `GET /capabilities` declares them.
 *
 * The suite needs the target seeded with at least one issue (any
 * tracker has issues; the suite discovers ids via `/issue-statuses`
 * rather than assuming a fixture). Optional-surface depth scales with
 * what the server contains: an empty plans list passes the shape checks
 * but exercises less — seed a plan and a scheduled issue for full
 * coverage (the bundled FakeTracker fixture does).
 */

import {
	type CapabilitiesResponse,
	TRACKER_ENDPOINTS,
	TRACKER_ISSUE_NOT_FOUND_CODE,
	TRACKER_PROTOCOL_VERSION,
} from "./protocol.ts";

export interface ConformanceTarget {
	readonly baseUrl: string;
	readonly bearerToken?: string;
	readonly fetchImpl?: typeof fetch;
}

export interface ConformanceFailure {
	readonly case: string;
	readonly detail: string;
}

export interface ConformanceResult {
	readonly passed: boolean;
	/** False ⇒ the server was rejected at negotiation; nothing else ran. */
	readonly versionNegotiated: boolean;
	readonly casesRun: number;
	readonly failures: readonly ConformanceFailure[];
}

interface Ctx {
	readonly target: ConformanceTarget;
	readonly failures: ConformanceFailure[];
	casesRun: number;
}

async function request(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
	const fetchImpl = ctx.target.fetchImpl ?? fetch;
	const headers: Record<string, string> = {};
	if (ctx.target.bearerToken !== undefined) {
		headers.authorization = `Bearer ${ctx.target.bearerToken}`;
	}
	if (body !== undefined) headers["content-type"] = "application/json";
	return fetchImpl(`${ctx.target.baseUrl}${path}`, {
		method,
		headers,
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
}

function fail(ctx: Ctx, caseName: string, detail: string): void {
	ctx.failures.push({ case: caseName, detail });
}

function check(ctx: Ctx, caseName: string, ok: boolean, detail: string): boolean {
	if (!ok) fail(ctx, caseName, detail);
	return ok;
}

async function readJson(ctx: Ctx, caseName: string, response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	check(
		ctx,
		caseName,
		contentType.includes("application/json"),
		`Content-Type must be application/json, got "${contentType}"`,
	);
	try {
		return await response.json();
	} catch {
		fail(ctx, caseName, `status ${response.status} returned a non-JSON body`);
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Negotiation: version match, boolean capability flags. Fail ⇒ abort. */
async function negotiate(ctx: Ctx): Promise<CapabilitiesResponse | undefined> {
	ctx.casesRun++;
	const caseName = "capabilities/negotiation";
	const response = await request(ctx, "GET", TRACKER_ENDPOINTS.capabilities);
	if (!check(ctx, caseName, response.ok, `GET /capabilities → ${response.status}, want 2xx`)) {
		return undefined;
	}
	const body = await readJson(ctx, caseName, response);
	if (!isRecord(body)) {
		fail(ctx, caseName, "capabilities payload is not an object");
		return undefined;
	}
	if (
		!check(
			ctx,
			caseName,
			body.protocolVersion === TRACKER_PROTOCOL_VERSION,
			`protocolVersion is "${String(body.protocolVersion)}", want "${TRACKER_PROTOCOL_VERSION}" — refusing to guess`,
		)
	) {
		return undefined;
	}
	const caps = body.capabilities;
	if (!isRecord(caps)) {
		fail(ctx, caseName, "capabilities.flags is not an object");
		return undefined;
	}
	let allBoolean = true;
	for (const flag of [
		"supportsPlans",
		"supportsMetadata",
		"supportsScheduledIssues",
		"isGitNative",
	] as const) {
		if (typeof caps[flag] !== "boolean") {
			fail(ctx, caseName, `capabilities.${flag} must be boolean, got ${typeof caps[flag]}`);
			allBoolean = false;
		}
	}
	if (!allBoolean) return undefined;
	return body as unknown as CapabilitiesResponse;
}

/** Base contract: issue reads + the status map. Returns a probe issue id. */
async function checkIssueReads(ctx: Ctx): Promise<string | undefined> {
	ctx.casesRun++;
	const statusesCase = "issue-statuses/shape";
	const response = await request(ctx, "GET", TRACKER_ENDPOINTS.issueStatuses);
	if (!check(ctx, statusesCase, response.ok, `GET /issue-statuses → ${response.status}`)) {
		return undefined;
	}
	const body = await readJson(ctx, statusesCase, response);
	if (!isRecord(body) || !isRecord(body.statuses)) {
		fail(ctx, statusesCase, "payload lacks a statuses object");
		return undefined;
	}
	const entries = Object.entries(body.statuses);
	if (
		!check(
			ctx,
			statusesCase,
			entries.length > 0,
			"server reports zero issues — seed the target with at least one issue",
		)
	) {
		return undefined;
	}
	for (const [id, status] of entries) {
		if (typeof status !== "string" || status.length === 0) {
			fail(ctx, statusesCase, `status for ${id} must be a non-empty raw string`);
		}
	}
	const probeId = (entries[0] as [string, string])[0];

	ctx.casesRun++;
	const issueCase = "issues/get";
	const issueResponse = await request(ctx, "GET", TRACKER_ENDPOINTS.issue(probeId));
	if (!check(ctx, issueCase, issueResponse.ok, `GET /issues/${probeId} → ${issueResponse.status}`)) {
		return undefined;
	}
	const issue = await readJson(ctx, issueCase, issueResponse);
	if (!isRecord(issue)) {
		fail(ctx, issueCase, "issue payload is not an object");
		return undefined;
	}
	check(ctx, issueCase, issue.id === probeId, `payload id ${String(issue.id)} ≠ path id ${probeId}`);
	check(
		ctx,
		issueCase,
		typeof issue.status === "string" && issue.status.length > 0,
		"issue status must be a non-empty raw string",
	);
	if (issue.blockedBy !== undefined) {
		check(
			ctx,
			issueCase,
			Array.isArray(issue.blockedBy) && issue.blockedBy.every((b) => typeof b === "string"),
			"blockedBy must be a string array when present",
		);
	}
	return probeId;
}

/** Not-found taxonomy on both the read and the close path. */
async function checkNotFoundTaxonomy(ctx: Ctx): Promise<void> {
	const missingId = `conformance-missing-${crypto.randomUUID()}`;
	for (const [caseName, response] of [
		["errors/issue-read-not-found", await request(ctx, "GET", TRACKER_ENDPOINTS.issue(missingId))],
		[
			"errors/issue-close-not-found",
			await request(ctx, "POST", TRACKER_ENDPOINTS.closeIssue(missingId)),
		],
	] as const) {
		ctx.casesRun++;
		if (
			!check(
				ctx,
				caseName,
				response.status >= 400 && response.status < 500,
				`missing id → ${response.status}, want a 4xx`,
			)
		) {
			continue;
		}
		const body = await readJson(ctx, caseName, response);
		if (!isRecord(body) || !isRecord(body.error)) {
			fail(ctx, caseName, "non-2xx body lacks the {error:{code,message}} envelope");
			continue;
		}
		check(
			ctx,
			caseName,
			body.error.code === TRACKER_ISSUE_NOT_FOUND_CODE,
			`error.code is "${String(body.error.code)}", want "${TRACKER_ISSUE_NOT_FOUND_CODE}"`,
		);
		check(
			ctx,
			caseName,
			typeof body.error.message === "string",
			"error.message must be a string",
		);
	}
}

/** Idempotent close + cross-view status consistency (the semantic core). */
async function checkCloseSemantics(ctx: Ctx, probeId: string): Promise<void> {
	ctx.casesRun++;
	const caseName = "issues/close-idempotent";
	const first = await request(ctx, "POST", TRACKER_ENDPOINTS.closeIssue(probeId));
	if (!check(ctx, caseName, first.ok, `first close → ${first.status}, want 2xx`)) return;
	const second = await request(ctx, "POST", TRACKER_ENDPOINTS.closeIssue(probeId));
	check(
		ctx,
		caseName,
		second.ok,
		`second close (already closed) → ${second.status}, want 2xx — close MUST be idempotent`,
	);

	ctx.casesRun++;
	const consistencyCase = "issues/close-status-consistency";
	const issue = await request(ctx, "GET", TRACKER_ENDPOINTS.issue(probeId));
	const statuses = await request(ctx, "GET", TRACKER_ENDPOINTS.issueStatuses);
	if (!issue.ok || !statuses.ok) {
		fail(ctx, consistencyCase, "post-close reads failed");
		return;
	}
	const issueBody = await readJson(ctx, consistencyCase, issue);
	const statusesBody = await readJson(ctx, consistencyCase, statuses);
	if (!isRecord(issueBody) || !isRecord(statusesBody) || !isRecord(statusesBody.statuses)) return;
	check(
		ctx,
		consistencyCase,
		issueBody.status === statusesBody.statuses[probeId],
		`GET /issues/${probeId} reports status "${String(issueBody.status)}" but /issue-statuses reports "${String(statusesBody.statuses[probeId])}" — the two views must agree on the raw status`,
	);
}

/** Plans surface (only when declared). */
async function checkPlans(ctx: Ctx): Promise<void> {
	ctx.casesRun++;
	const listCase = "plans/list";
	const response = await request(ctx, "GET", TRACKER_ENDPOINTS.plans);
	if (!check(ctx, listCase, response.ok, `GET /plans → ${response.status}`)) return;
	const body = await readJson(ctx, listCase, response);
	if (!isRecord(body) || !Array.isArray(body.plans)) {
		fail(ctx, listCase, "payload lacks a plans array");
		return;
	}
	for (const raw of body.plans) {
		if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.status !== "string") {
			fail(ctx, listCase, "plan summary must carry string id + status");
			return;
		}
		check(
			ctx,
			listCase,
			typeof raw.childCount === "number",
			`plan ${raw.id} summary must carry a numeric childCount`,
		);
	}
	const first = body.plans[0];
	if (!isRecord(first) || typeof first.id !== "string") return;

	ctx.casesRun++;
	const getCase = "plans/get";
	const planResponse = await request(ctx, "GET", TRACKER_ENDPOINTS.plan(first.id));
	if (!check(ctx, getCase, planResponse.ok, `GET /plans/${first.id} → ${planResponse.status}`)) {
		return;
	}
	const plan = await readJson(ctx, getCase, planResponse);
	if (!isRecord(plan)) {
		fail(ctx, getCase, "plan payload is not an object");
		return;
	}
	check(ctx, getCase, plan.id === first.id, "plan payload id ≠ path id");
	check(
		ctx,
		getCase,
		typeof plan.status === "string" && Array.isArray(plan.children),
		"plan payload must carry a string status and a children id array",
	);

	ctx.casesRun++;
	const missingCase = "plans/get-not-found";
	const missing = await request(
		ctx,
		"GET",
		TRACKER_ENDPOINTS.plan(`conformance-missing-${crypto.randomUUID()}`),
	);
	if (check(ctx, missingCase, !missing.ok, `missing plan → ${missing.status}, want non-2xx`)) {
		const missingBody = await readJson(ctx, missingCase, missing);
		if (isRecord(missingBody) && isRecord(missingBody.error)) {
			check(
				ctx,
				missingCase,
				missingBody.error.code === TRACKER_ISSUE_NOT_FOUND_CODE,
				`missing plan error.code "${String(missingBody.error.code)}", want "${TRACKER_ISSUE_NOT_FOUND_CODE}"`,
			);
		} else {
			fail(ctx, missingCase, "missing-plan body lacks the error envelope");
		}
	}
}

/** Metadata surface (only when declared): shallow merge + null clears. */
async function checkMetadata(ctx: Ctx, probeId: string): Promise<void> {
	const key = "conformance.probe";
	const setCase = "metadata/merge-sets";
	ctx.casesRun++;
	const setResponse = await request(ctx, "POST", TRACKER_ENDPOINTS.metadata(probeId), {
		metadata: { [key]: "1" },
	});
	if (!check(ctx, setCase, setResponse.ok, `metadata merge → ${setResponse.status}`)) return;
	const after = await request(ctx, "GET", TRACKER_ENDPOINTS.issue(probeId));
	const afterBody = await readJson(ctx, setCase, after);
	if (!isRecord(afterBody)) return;
	if (!isRecord(afterBody.metadata)) {
		fail(ctx, setCase, "issue metadata absent after a successful merge");
		return;
	}
	check(
		ctx,
		setCase,
		afterBody.metadata[key] === "1",
		`merged key read back as ${JSON.stringify(afterBody.metadata[key])}, want "1"`,
	);

	const clearCase = "metadata/merge-null-clears";
	ctx.casesRun++;
	const clearResponse = await request(ctx, "POST", TRACKER_ENDPOINTS.metadata(probeId), {
		metadata: { [key]: null },
	});
	if (!check(ctx, clearCase, clearResponse.ok, `null-clear merge → ${clearResponse.status}`)) {
		return;
	}
	const cleared = await request(ctx, "GET", TRACKER_ENDPOINTS.issue(probeId));
	const clearedBody = await readJson(ctx, clearCase, cleared);
	if (!isRecord(clearedBody)) return;
	const metadata = isRecord(clearedBody.metadata) ? clearedBody.metadata : {};
	check(
		ctx,
		clearCase,
		!(key in metadata),
		`explicit null must REMOVE the key; ${key} still present as ${JSON.stringify(metadata[key])}`,
	);
}

/** Scheduled-issues surface (only when declared). */
async function checkScheduledIssues(ctx: Ctx): Promise<void> {
	ctx.casesRun++;
	const caseName = "scheduled-issues/shape";
	const response = await request(ctx, "GET", TRACKER_ENDPOINTS.scheduledIssues);
	if (!check(ctx, caseName, response.ok, `GET /scheduled-issues → ${response.status}`)) return;
	const body = await readJson(ctx, caseName, response);
	if (!isRecord(body) || !Array.isArray(body.issues)) {
		fail(ctx, caseName, "payload lacks an issues array");
		return;
	}
	for (const raw of body.issues) {
		if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.status !== "string") {
			fail(ctx, caseName, "scheduled issue must carry string id + status");
			return;
		}
		const when = typeof raw.scheduledFor === "string" ? Date.parse(raw.scheduledFor) : Number.NaN;
		check(
			ctx,
			caseName,
			!Number.isNaN(when),
			`scheduledFor must be an ISO-8601 string, got ${JSON.stringify(raw.scheduledFor)}`,
		);
	}
}

/**
 * Run the full suite against a target. Never throws for a conformance
 * failure — failures are data; throws only for a transport-level
 * inability to reach the server at all.
 */
export async function runConformanceSuite(target: ConformanceTarget): Promise<ConformanceResult> {
	const ctx: Ctx = { target, failures: [], casesRun: 0 };
	const capabilities = await negotiate(ctx);
	if (capabilities === undefined) {
		return {
			passed: false,
			versionNegotiated: false,
			casesRun: ctx.casesRun,
			failures: ctx.failures,
		};
	}

	const probeId = await checkIssueReads(ctx);
	await checkNotFoundTaxonomy(ctx);
	if (probeId !== undefined) {
		await checkCloseSemantics(ctx, probeId);
	}
	if (capabilities.capabilities.supportsPlans) {
		await checkPlans(ctx);
	}
	if (capabilities.capabilities.supportsMetadata && probeId !== undefined) {
		await checkMetadata(ctx, probeId);
	}
	if (capabilities.capabilities.supportsScheduledIssues) {
		await checkScheduledIssues(ctx);
	}

	return {
		passed: ctx.failures.length === 0,
		versionNegotiated: true,
		casesRun: ctx.casesRun,
		failures: ctx.failures,
	};
}
