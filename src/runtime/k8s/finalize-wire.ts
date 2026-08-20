/**
 * The finalize CALLBACK wire contract (pl-829f step 20 / warren-0d35).
 *
 * The K8s backend runs the workspace-dependent half of reap (contract §4
 * `finalize`) as a POST-agent step INSIDE the run pod, because the pod's
 * `emptyDir` workspace is unreachable from the control plane (design
 * `runtime-provider-contract.md` §4 — `exec()` was rejected as leaky). This
 * module defines the two JSON payloads that cross the authenticated callback
 * channel (step 17's decision: deltas ride the HTTP callback, NOT the NDJSON log
 * stream, whose per-line JSON is reserved for agent events):
 *
 *   1. `InPodFinalizeIntent` — warren → pod. The neutral `FinalizeIntent` the
 *      domain computed at reap, projected onto a pod-shaped wire: no host paths
 *      (`projectClonePathHint` is dropped — the K8s backend has no clone in the
 *      pod), plus the short-lived git push credential the pod needs (the agent
 *      container never holds it — see `provider.ts` / the entrypoint). The pod
 *      polls `GET /runs/:id/finalize-intent` for this AFTER the agent exits.
 *
 *   2. `FinalizeResultEnvelope` — pod → warren. The in-pod harness's collected
 *      `FinalizeResult` (contract-shaped, already JSON-serializable by design —
 *      the delta shapes were pinned in step 12 for exactly this wire) wrapped
 *      with the `attemptId` that correlates it to the awaiting `finalize()`
 *      call. POSTed to `POST /runs/:id/finalize-result`.
 *
 * Validation is structural + defensive: the callback is bearer-gated (only the
 * operator-trusted pod can reach it), but a malformed body must never crash the
 * awaiting `finalize()` — it becomes a 400 the entrypoint can retry, or is
 * dropped. `validateFinalizeResult` narrows an `unknown` body onto the
 * `FinalizeResult` the domain consumes so a bad payload can't smuggle a
 * wrong-shaped delta into reap.
 */

import { ValidationError } from "../../core/errors.ts";
import { isSalvageTrigger, type SalvageTrigger } from "../../core/wire.ts";
import type {
	ArtifactDelta,
	ArtifactDeltaFile,
	FinalizeEvent,
	FinalizeResult,
	FinalizeStageOutcome,
} from "../contract.ts";
import { isFinalizeStage } from "../contract.ts";

/** Wire-format version tag so the intent shape can evolve unambiguously. */
export const IN_POD_FINALIZE_WIRE_VERSION = 1 as const;

/**
 * The finalize INTENT served to the in-pod harness. A pod-shaped projection of
 * the neutral `FinalizeIntent` (`../contract.ts`): the merge/commit gating +
 * branch/baseBranch travel verbatim, `projectClonePathHint` is dropped (no clone
 * in the pod), and a short-lived `gitToken` is added so the harness can
 * authenticate the single reap push (the run pod's `origin` remote had its token
 * stripped after clone — see `workspace-init.ts`).
 */
export interface InPodFinalizeIntent {
	version: typeof IN_POD_FINALIZE_WIRE_VERSION;
	/** Correlates the result POST back to the awaiting `finalize()` call. */
	attemptId: string;
	/** Per-run branch to push `HEAD:` onto (`""` ⇒ push bare `HEAD`). */
	branch: string;
	/** Whether to push at all (mirrors `FinalizeIntent.push`). */
	push: boolean;
	/** Opaque artifact-set keys to extract (mirrors `FinalizeIntent.artifacts`). */
	artifacts: string[];
	/** Bookkeeping commits to author before the push (mirrors `FinalizeIntent.commit`). */
	commit: string[];
	/** Base ref for the commits-ahead count; omitted ⇒ count skipped (`null`). */
	baseBranch?: string;
	/**
	 * Short-lived git push credential. Delivered here — over the authenticated
	 * callback, AFTER the agent exits — rather than in the agent container's
	 * static env, so a compromised agent never holds the push token (blast-radius
	 * minimization; see the push-credential decision in `provider.ts`). Omitted
	 * for public repos / when warren holds no token.
	 */
	gitToken?: string;
}

/** The envelope the in-pod harness POSTs to `POST /runs/:id/finalize-result`. */
export interface FinalizeResultEnvelope {
	version: typeof IN_POD_FINALIZE_WIRE_VERSION;
	/** Echoes the `attemptId` from the intent — the correlation key. */
	attemptId: string;
	/** The collected, contract-shaped finalize artifacts. */
	result: FinalizeResult;
}

/**
 * The SALVAGE envelope the in-pod harness POSTs to `POST /runs/:id/salvage`
 * (warren-cd3b). Sent when the run's work would otherwise be lost: the primary
 * branch push failed (`push_failed` — e.g. GitHub push protection rejected it)
 * or no reap intent ever arrived before the pod had to exit (`no_intent` — a
 * control-plane restart / severed callback). Unlike the finalize result, this
 * carries the work ITSELF (a git bundle) because the pod's volume is about to
 * die with the container. See `../salvage.ts` for the two capture forms.
 *
 * warren-985e: a third trigger, `empty_push_dirty`, covers the run that died
 * mid-work (e.g. provider_error credit exhaustion) with ZERO commits ahead
 * and a dirty tree — the push "succeeded" but carried nothing, so the
 * uncommitted diff is folded into a salvage commit and captured here.
 */
export interface SalvageEnvelope {
	version: typeof IN_POD_FINALIZE_WIRE_VERSION;
	/** Why salvage ran (canonical vocabulary: `src/core/wire.ts`). */
	trigger: SalvageTrigger;
	/** The rescue branch the pod pushed to origin, when that push landed. */
	rescueRef: string | null;
	/** base64 git bundle of the run's commits, when one was produced. */
	bundleBase64: string | null;
	/** Branch the workspace HEAD was on, when known. */
	branch: string | null;
	/** Base ref used for the bundle range, when known. */
	baseBranch: string | null;
	/** Best-effort diagnostics from the salvage attempt (never secret material). */
	notes: string[];
}

/* -------------------------------------------------------------------------- */
/* Validation (pod → warren intake)                                           */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(`${label} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function reqString(obj: Record<string, unknown>, key: string, label: string): string {
	const v = obj[key];
	if (typeof v !== "string" || v.length === 0) {
		throw new ValidationError(`${label}.${key} must be a non-empty string`);
	}
	return v;
}

/**
 * warren-8e05: a delta file's body may be legitimately empty — `ml prune` leaves
 * zero-byte `.mulch/expertise/*.jsonl` domain files, and the collector ships
 * workspace truth verbatim. Rejecting `""` here failed every finalize-result
 * POST from a workspace with an empty tracker file.
 */
function reqStringAllowEmpty(obj: Record<string, unknown>, key: string, label: string): string {
	const v = obj[key];
	if (typeof v !== "string") throw new ValidationError(`${label}.${key} must be a string`);
	return v;
}

function reqBoolean(obj: Record<string, unknown>, key: string, label: string): boolean {
	const v = obj[key];
	if (typeof v !== "boolean") throw new ValidationError(`${label}.${key} must be a boolean`);
	return v;
}

/** Accept a finite number OR `null` (the widened `commitsAhead` shape). */
function reqNumberOrNull(obj: Record<string, unknown>, key: string, label: string): number | null {
	const v = obj[key];
	if (v === null) return null;
	if (typeof v !== "number" || !Number.isFinite(v)) {
		throw new ValidationError(`${label}.${key} must be a finite number or null`);
	}
	return v;
}

function optStringOrNull(obj: Record<string, unknown>, key: string, label: string): string | null {
	const v = obj[key];
	if (v === undefined || v === null) return null;
	if (typeof v !== "string") throw new ValidationError(`${label}.${key} must be a string or null`);
	return v;
}

/** warren-89b0: optional `string[]` (absent ⇒ `undefined`, kept off the shape). */
function optStringArray(
	obj: Record<string, unknown>,
	key: string,
	label: string,
): readonly string[] | undefined {
	const v = obj[key];
	if (v === undefined) return undefined;
	if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
		throw new ValidationError(`${label}.${key} must be an array of strings`);
	}
	return v as string[];
}

function reqNonNegInt(obj: Record<string, unknown>, key: string, label: string): number {
	const v = obj[key];
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
		throw new ValidationError(`${label}.${key} must be a non-negative integer`);
	}
	return v;
}

/**
 * Narrow one opaque artifact delta (warren-df3e). Feature-neutral: validates the
 * `files[]` bodies + the opaque `counts` map (every value a non-negative
 * integer); it does NOT assume which artifact produced the delta.
 */
function validateArtifactDelta(value: unknown, key: string): ArtifactDelta {
	const label = `artifacts.${key}`;
	const o = asRecord(value, label);
	const filesRaw = o.files;
	if (!Array.isArray(filesRaw)) throw new ValidationError(`${label}.files must be an array`);
	const files: ArtifactDeltaFile[] = filesRaw.map((f, i) => {
		const fo = asRecord(f, `${label}.files[${i}]`);
		return {
			path: reqString(fo, "path", `${label}.files[${i}]`),
			mergedBody: reqStringAllowEmpty(fo, "mergedBody", `${label}.files[${i}]`),
		};
	});
	const countsRaw = asRecord(o.counts ?? {}, `${label}.counts`);
	const counts: Record<string, number> = {};
	for (const name of Object.keys(countsRaw)) {
		counts[name] = reqNonNegInt(countsRaw, name, `${label}.counts`);
	}
	return { version: 1, files, counts };
}

/**
 * warren-357c: stage names are no longer a fixed union — the merge/commit
 * stages derive from the opaque artifact keys, so intake validates the SHAPE
 * (pipeline stage or `${key}_merge` / `${key}_commit`), not a feature list.
 */
function validateStages(value: unknown): FinalizeStageOutcome[] {
	if (!Array.isArray(value)) throw new ValidationError("result.stages must be an array");
	return value.map((s, i) => {
		const so = asRecord(s, `result.stages[${i}]`);
		const stage = reqString(so, "stage", `result.stages[${i}]`);
		if (!isFinalizeStage(stage)) {
			throw new ValidationError(
				`result.stages[${i}].stage "${stage}" is not a known finalize stage`,
			);
		}
		const status = reqString(so, "status", `result.stages[${i}]`);
		if (status !== "ok" && status !== "skipped" && status !== "failed") {
			throw new ValidationError(`result.stages[${i}].status must be ok|skipped|failed`);
		}
		const error = so.error;
		if (error !== undefined && typeof error !== "string") {
			throw new ValidationError(`result.stages[${i}].error must be a string when present`);
		}
		return {
			stage,
			status,
			...(typeof error === "string" ? { error } : {}),
		};
	});
}

function validateEvents(value: unknown): FinalizeEvent[] {
	if (!Array.isArray(value)) throw new ValidationError("result.events must be an array");
	return value.map((e, i) => {
		const eo = asRecord(e, `result.events[${i}]`);
		return { kind: reqString(eo, "kind", `result.events[${i}]`), payload: eo.payload };
	});
}

/**
 * Narrow an `unknown` callback body onto the `FinalizeResult` the reap domain
 * consumes. Structural + defensive (see module doc): throws `ValidationError`
 * on any shape mismatch so a malformed pod POST becomes a 400, never a
 * wrong-shaped delta smuggled into reap. The nested delta objects are optional;
 * each present one is validated in full.
 */
export function validateFinalizeResult(value: unknown): FinalizeResult {
	const o = asRecord(value, "result");
	const artifactsRaw = asRecord(o.artifacts ?? {}, "result.artifacts");
	const artifacts: FinalizeResult["artifacts"] = {};
	for (const key of Object.keys(artifactsRaw)) {
		artifacts[key] = validateArtifactDelta(artifactsRaw[key], key);
	}

	const dirtyPaths = optStringArray(o, "dirtyPaths", "result");
	// warren-ba08: optional — an older in-pod image omits it (domain falls back to baseBranch).
	const commitsAheadBase = optStringOrNull(o, "commitsAheadBase", "result");
	return {
		pushed: reqBoolean(o, "pushed", "result"),
		commitsAhead: reqNumberOrNull(o, "commitsAhead", "result"),
		...(commitsAheadBase !== null ? { commitsAheadBase } : {}),
		emptyPush: reqBoolean(o, "emptyPush", "result"),
		dirty: reqBoolean(o, "dirty", "result"),
		...(dirtyPaths !== undefined ? { dirtyPaths } : {}),
		workspacePlansBody: optStringOrNull(o, "workspacePlansBody", "result"),
		events: validateEvents(o.events),
		artifacts,
		prBranch: optStringOrNull(o, "prBranch", "result"),
		stages: validateStages(o.stages),
	};
}

/**
 * Narrow an `unknown` `POST /runs/:id/finalize-result` body onto a
 * `FinalizeResultEnvelope`. The version is checked so a future wire bump fails
 * loud rather than mis-parsing.
 */
export function parseFinalizeResultEnvelope(value: unknown): FinalizeResultEnvelope {
	const o = asRecord(value, "body");
	const version = o.version;
	if (version !== IN_POD_FINALIZE_WIRE_VERSION) {
		throw new ValidationError(
			`unsupported finalize wire version ${String(version)} (expected ${IN_POD_FINALIZE_WIRE_VERSION})`,
		);
	}
	return {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		attemptId: reqString(o, "attemptId", "body"),
		result: validateFinalizeResult(o.result),
	};
}

/**
 * Narrow an `unknown` `POST /runs/:id/salvage` body onto a `SalvageEnvelope`
 * (warren-cd3b). Same defensive posture as the finalize envelope: a malformed
 * body is a 400 the pod can retry, never a crash. The bundle is capped by the
 * handler (the parser only checks shape); `notes` is a bounded string list.
 */
export function parseSalvageEnvelope(value: unknown): SalvageEnvelope {
	const o = asRecord(value, "body");
	const version = o.version;
	if (version !== IN_POD_FINALIZE_WIRE_VERSION) {
		throw new ValidationError(
			`unsupported salvage wire version ${String(version)} (expected ${IN_POD_FINALIZE_WIRE_VERSION})`,
		);
	}
	const triggerRaw = reqString(o, "trigger", "body");
	if (!isSalvageTrigger(triggerRaw)) {
		throw new ValidationError(
			'body.trigger must be "push_failed", "no_intent", or "empty_push_dirty"',
		);
	}
	const trigger: SalvageTrigger = triggerRaw;
	const notes = optStringArray(o, "notes", "body");
	return {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		trigger,
		rescueRef: optStringOrNull(o, "rescueRef", "body"),
		bundleBase64: optStringOrNull(o, "bundleBase64", "body"),
		branch: optStringOrNull(o, "branch", "body"),
		baseBranch: optStringOrNull(o, "baseBranch", "body"),
		notes: notes !== undefined ? [...notes] : [],
	};
}
