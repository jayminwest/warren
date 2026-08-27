/**
 * `warren doctor` — startup health check.
 *
 * Runs the union of:
 *   - required env vars (WARREN_API_TOKEN),
 *   - bwrap binary reachable (Phase 13),
 *   - projects root resolvable (non-fatal),
 *   - per-project `.warren/` config validity (R-02, pl-5d74 step 6),
 *   - the local runtime is the in-process sandbox engine (warren-9a26).
 *
 * The Phase-13 bwrap probe lives in
 * `src/diagnostics/checks.ts` so `GET /readyz` mirrors it without
 * duplicating logic. Each check returns `{name, ok, message?, hint?}`;
 * the command exits 0 when every check passes and 1 otherwise.
 */

import { existsSync } from "node:fs";
import { ValidationError } from "../../core/errors.ts";
import type { AnyWarrenDb } from "../../db/client.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import { createRepos } from "../../db/repos/index.ts";
import {
	checkBwrap,
	checkDatabaseReachable,
	checkGitIdentity,
	checkPreviewAuthStrength,
	checkPreviewPortAllocator,
	checkSandboxGit,
	checkWarrenConfig,
	checkWarrenConfigDeprecations,
	checkWarrenDb,
	type DiagnosticCheck,
	type DiagnosticLogger,
	type WarrenConfigCheckProject,
} from "../../diagnostics/checks.ts";
import { checkStaleSandboxWorkspaces } from "../../diagnostics/stale-workspaces.ts";
import { loadPreviewPortRangeFromEnv, PreviewPortAllocator } from "../../preview/port-allocator.ts";
import { loadProjectsConfigFromEnv } from "../../projects/config.ts";
import { loadWorkspaceGcConfigFromEnv } from "../../runs/reap/gc.ts";
import { doctorLocalRuntimeCheck } from "../../runtime/local/diagnostics/local-runtime.ts";
import { resolveRuntimeKind } from "../../runtime/registry.ts";
import type { SandboxGitPreflightResult } from "../../sandbox/git-preflight.ts";
import type { CliContext, EnvLike } from "../output.ts";
import { writeJsonLine } from "../output.ts";

export type DoctorCheck = DiagnosticCheck;

export interface DoctorArgs {
	readonly noAuth?: boolean;
	/**
	 * When true, wire a stderr logger into the probes that deliberately
	 * withhold raw driver/loader text from the check messages
	 * (warren-51de). The CLI has no server logger seam, so without this
	 * flag the raw text is dropped entirely (warren-2d14). Default output
	 * is unchanged.
	 */
	readonly verbose?: boolean;
}

export interface DoctorDeps {
	/** Override the local-runtime probe (tests). */
	readonly probeLocalRuntime?: (env: EnvLike) => Promise<void>;
	/** Override `existsSync` (tests). */
	readonly existsSync?: (path: string) => boolean;
	/**
	 * Registered projects to validate `.warren/` against. `main.ts` wires
	 * this from the live projects table via `withCliDb`; tests pass a
	 * synthetic list (or omit for an empty registry). When the list is
	 * empty the warren_config check still runs and reports an
	 * informational `ok: true`.
	 */
	readonly projects?: ReadonlyArray<WarrenConfigCheckProject>;
	/**
	 * Live db handle for the `db_reachable` probe (R-13 pl-f17e step 5,
	 * warren-e2ea). `main.ts` wires this from `withCliDb`; tests omit
	 * and the check degrades to an informational `ok: true`.
	 */
	readonly db?: AnyWarrenDb;
	/**
	 * Platform seam for the bwrap probe. Production omits it
	 * (`checkBwrap` reads `process.platform`); tests force `"linux"` so
	 * the probe path runs identically on macOS dev machines.
	 */
	readonly platform?: NodeJS.Platform;
	/**
	 * Override the sandbox-git preflight probe (warren-1219). Production
	 * omits it (the boot-cached real probe runs, host bwrap/sandbox-exec
	 * included); tests stub the result.
	 */
	readonly probeSandboxGit?: () => Promise<SandboxGitPreflightResult>;
}

export interface DoctorResult {
	readonly exitCode: number;
	readonly checks: readonly DoctorCheck[];
}

export async function runDoctor(
	context: CliContext,
	deps: DoctorDeps,
	args: DoctorArgs,
): Promise<DoctorResult> {
	const exists = deps.existsSync ?? existsSync;
	const checks: DoctorCheck[] = [];
	// The local-sandbox probes (bwrap, stale workspaces, the local-runtime line)
	// only make sense for the LOCAL backend, where warren runs sandboxes
	// in-process on the host. Under `WARREN_RUNTIME=k8s` agents run in pods, so
	// we skip them cleanly and emit a single informational line saying so —
	// mirroring the `/readyz` behavior (warren-c128,
	// src/server/handlers/diagnostics.ts).
	const isLocalTopology = resolveRuntimeKind(context.env) === "local";

	checks.push(envCheck("WARREN_API_TOKEN", context.env, args.noAuth ?? false));
	// warren-e7b7: unset agent git identity is a WARNING (always ok:true),
	// surfaced here because the K8s topology has no supervisor to warn.
	checks.push(checkGitIdentity(context.env));

	// Threaded per-call, never a global: only the probes that already
	// accept a `log` seam (warren-51de) receive it, and only under
	// --verbose. `GET /readyz` wires its own pino logger server-side.
	const verboseLog = args.verbose === true ? verboseLogger(context) : undefined;

	checks.push(checkWarrenDb({ env: context.env }));
	checks.push(
		await checkDatabaseReachable({
			...(deps.db !== undefined ? { db: deps.db } : {}),
			...(verboseLog !== undefined ? { log: verboseLog } : {}),
		}),
	);

	checks.push(projectsRootCheck(context.env, exists));

	if (isLocalTopology) {
		checks.push(
			await checkBwrap({
				spawn: context.spawn,
				...(deps.platform !== undefined ? { platform: deps.platform } : {}),
			}),
		);
		// warren-1219: prove the resolved git EXECUTES inside the composed
		// sandbox profile — the macOS nix-git dyld failure class, caught at
		// doctor time instead of as a dropped_commit run failure. Runs only
		// when a probe is wired: `main.ts` wires the real (boot-cached)
		// probe, tests stub it — a bare `runDoctor` call stays hermetic
		// (no host bwrap/sandbox-exec spawn from the unit suite).
		if (deps.probeSandboxGit !== undefined) {
			checks.push(await checkSandboxGit({ probe: deps.probeSandboxGit }));
		}
	}

	checks.push(
		await checkWarrenConfig({
			projects: deps.projects ?? [],
			...(verboseLog !== undefined ? { log: verboseLog } : {}),
		}),
	);
	checks.push(await checkWarrenConfigDeprecations({ projects: deps.projects ?? [] }));

	checks.push(await previewPortAllocatorCheck(context.env, deps.db));

	if (isLocalTopology) {
		checks.push(await staleBurrowWorkspacesCheck(context.env, deps.db));
	}

	checks.push(checkPreviewAuthStrength({ env: context.env }));

	if (isLocalTopology) {
		checks.push(await doctorLocalRuntimeCheck(context.env, deps.probeLocalRuntime));
	} else {
		checks.push({
			name: "runtime_backend",
			ok: true,
			message: "k8s: bwrap / stale-workspace / local-runtime probes skipped (agents run in pods)",
		});
	}

	return emitDoctorReport(context, checks);
}

/**
 * Write the checks as NDJSON, emit the stderr banner on any failure, and
 * map all-ok to the exit code. Shared by both doctor halves (warren-97a2):
 * the local half here and the client half in `doctor-remote.ts`.
 */
export function emitDoctorReport(
	context: CliContext,
	checks: readonly DoctorCheck[],
): { readonly exitCode: number; readonly checks: readonly DoctorCheck[] } {
	for (const check of checks) {
		writeJsonLine(context.stdio.stdout, check);
	}

	const allOk = checks.every((c) => c.ok);
	if (!allOk) {
		context.stdio.stderr.write("warren: one or more checks failed\n");
	}
	return { exitCode: allOk ? 0 : 1, checks };
}

/**
 * The `--verbose` logger (warren-2d14): a `DiagnosticLogger` that writes
 * the raw probe detail the wire messages withhold to stderr, one line
 * per failure. Stderr (not stdout) so the newline-delimited-JSON check
 * stream on stdout stays machine-parseable unchanged.
 */
function verboseLogger(context: CliContext): DiagnosticLogger {
	return {
		warn(obj: object, msg?: string): void {
			context.stdio.stderr.write(
				`warren doctor verbose: ${msg ?? "probe failed"} ${JSON.stringify(obj)}\n`,
			);
		},
	};
}

function envCheck(name: string, env: EnvLike, exempted: boolean): DoctorCheck {
	if (exempted) {
		return { name, ok: true, message: "skipped (--no-auth)" };
	}
	const value = env[name];
	if (value !== undefined && value !== "") return { name, ok: true };
	return {
		name,
		ok: false,
		message: `${name} is not set`,
		hint: `export ${name}=...`,
	};
}

function projectsRootCheck(env: EnvLike, exists: (path: string) => boolean): DoctorCheck {
	let config: ReturnType<typeof loadProjectsConfigFromEnv>;
	try {
		config = loadProjectsConfigFromEnv(env);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { name: "projects_root", ok: false, message };
	}
	// Missing root is non-fatal — addProject will mkdirp on first use. Just
	// surface the path for visibility.
	return {
		name: "projects_root",
		ok: true,
		message: exists(config.root)
			? config.root
			: `${config.root} (will be created on first project add)`,
	};
}

async function staleBurrowWorkspacesCheck(
	env: EnvLike,
	db: AnyWarrenDb | undefined,
): Promise<DoctorCheck> {
	let ttlMs: number;
	try {
		ttlMs = loadWorkspaceGcConfigFromEnv(env).ttlMs;
	} catch (err) {
		return {
			name: "stale_sandbox_workspaces",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
	if (db === undefined) {
		return { name: "stale_sandbox_workspaces", ok: true, message: "no db handle wired" };
	}
	const repos = createRepos(db);
	return checkStaleSandboxWorkspaces({
		probe: {
			listByState: (state) => repos.runs.listByState(state),
		},
		ttlMs,
	});
}

async function previewPortAllocatorCheck(
	env: EnvLike,
	db: AnyWarrenDb | undefined,
): Promise<DoctorCheck> {
	// Range parse is the operator-facing typo path; surface it as a check
	// failure before we touch the db so the message names the env var.
	let range: ReturnType<typeof loadPreviewPortRangeFromEnv>;
	try {
		range = loadPreviewPortRangeFromEnv(env);
	} catch (err) {
		if (err instanceof ValidationError) {
			return {
				name: "preview_port_allocator",
				ok: false,
				message: err.message,
				...(err.recoveryHint !== undefined ? { hint: err.recoveryHint } : {}),
			};
		}
		return {
			name: "preview_port_allocator",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
	if (db === undefined) {
		return {
			name: "preview_port_allocator",
			ok: true,
			message: `no db handle wired (range ${range.start}-${range.end})`,
		};
	}
	// Allocator construction is non-destructive — usage() is a pure read
	// against the runs table. Dialect-polymorphic since warren-adfb.
	const allocator = new PreviewPortAllocator(DrizzleAdapter.for(db), range);
	return checkPreviewPortAllocator({ probe: allocator });
}
