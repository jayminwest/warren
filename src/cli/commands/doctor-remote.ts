/**
 * `warren doctor` (client half, warren-97a2 / owner decision D3).
 *
 * Post-collapse, plain `warren doctor` checks the CLIENT's view of a
 * (possibly remote) warren: is the server reachable, does the configured
 * credential authenticate, and does the server version match the CLI's.
 * The deployment-side probes (bwrap, sandbox runtime, projects root, DB
 * reachability, per-project `.warren/` validity) only make sense on the
 * host warren is deployed on — they live behind `warren doctor --local`
 * in `./doctor.ts`.
 *
 * Checks emit one NDJSON `{name, ok, message?, hint?}` line each,
 * mirroring the local half; the command exits 0 when every check passes
 * and 1 otherwise.
 */

import { clientConfigPath } from "../../client/config-file.ts";
import type { WarrenClient } from "../../client/index.ts";
import { VERSION } from "../../index.ts";
import { authFailureHint } from "../auth-hints.ts";
import {
	type ClientConfigSource,
	type ClientFlags,
	resolveWarrenClientWithSources,
} from "../client.ts";
import type { CliContext, EnvLike } from "../output.ts";
import { formatError } from "../output.ts";
import { type DoctorCheck, emitDoctorReport } from "./doctor.ts";

export interface RemoteDoctorArgs {
	/** Skip the auth check (`warren doctor --no-auth`, loopback dev mode). */
	readonly noAuth?: boolean;
}

export interface RemoteDoctorDeps {
	/** Remote warren client. Production wires it through `remoteDoctorDeps`. */
	readonly client: WarrenClient;
	/** Override the probe timeout (tests). */
	readonly probeTimeoutMs?: number;
	/** Override the CLI version compared against the server (tests). */
	readonly cliVersion?: string;
	/**
	 * Which slot supplied the token, from `resolveWarrenClientWithSources`.
	 * Absent means NO TOKEN in any slot, which is an ordinary production
	 * state: the resolution picks from flag, env and config file with no
	 * default arm, so it omits the source exactly when all three are empty
	 * (warren-4f1b).
	 */
	readonly tokenSource?: ClientConfigSource;
	/** Which slot supplied the base URL. Absent leaves the line as the URL alone. */
	readonly baseUrlSource?: ClientConfigSource;
}

export interface RemoteDoctorResult {
	readonly exitCode: number;
	readonly checks: readonly DoctorCheck[];
}

/**
 * Production wiring for {@link RemoteDoctorDeps}: resolve the client and keep
 * the slot each half of its config came from, so the report can name them.
 * Tests build the deps by hand instead.
 */
export function remoteDoctorDeps(env: EnvLike, flags: ClientFlags): RemoteDoctorDeps {
	return resolveWarrenClientWithSources(env, flags);
}

export async function runRemoteDoctor(
	context: CliContext,
	deps: RemoteDoctorDeps,
	args: RemoteDoctorArgs,
): Promise<RemoteDoctorResult> {
	const checks: DoctorCheck[] = [];

	// 1. Reachability gates the rest: a down server makes the auth and
	// version probes unanswerable, so stop after the failed probe rather
	// than piling on secondary failures.
	try {
		await (deps.probeTimeoutMs !== undefined
			? deps.client.probe(deps.probeTimeoutMs)
			: deps.client.probe());
		const from = baseUrlSourceLabel(deps.baseUrlSource);
		const baseUrl = deps.client.config.baseUrl;
		checks.push({
			name: "server_reachable",
			ok: true,
			message: from === undefined ? baseUrl : `${baseUrl} (from ${from})`,
		});
	} catch (err) {
		checks.push({
			name: "server_reachable",
			ok: false,
			message: formatError(err),
			hint: baseUrlFailureHint(deps.baseUrlSource, deps.client.config.baseUrl, context.env),
		});
		return finish(context, checks);
	}

	// 2. Auth: `/whoami` is a gated route — a missing/stale token 401s here.
	if (args.noAuth === true) {
		checks.push({ name: "auth_valid", ok: true, message: "skipped (--no-auth)" });
	} else {
		checks.push(await authCheck(deps.client, deps.tokenSource, context.env));
	}

	// 3. Version match: a skewed CLI speaks a wire shape the server may
	// have moved on from. Mismatch is a failure with an upgrade hint.
	checks.push(await versionCheck(deps.client, deps.cliVersion ?? VERSION));

	return finish(context, checks);
}

/** How the base URL slot reads in operator-facing output (warren-8807). */
function baseUrlSourceLabel(source: ClientConfigSource | undefined): string | undefined {
	switch (source) {
		case "flag":
			return "--url";
		case "env":
			return "WARREN_BASE_URL";
		case "config-file":
			return "the client config file";
		case "default":
			return "the built-in default";
		default:
			return undefined;
	}
}

/**
 * Where to look when the server did not answer. The fixed text named
 * `WARREN_BASE_URL` and `--url` whatever the URL came from, so a stale URL
 * in the config file sent the operator to two slots that had not supplied
 * it (warren-4f1b). The slot is already resolved on the ok line; this is
 * the path where it matters.
 */
function baseUrlFailureHint(
	source: ClientConfigSource | undefined,
	baseUrl: string,
	env: EnvLike,
): string {
	const serving = "and that `warren serve` is running there";
	switch (source) {
		case "flag":
			return `${baseUrl} came from --url; check it ${serving}`;
		case "env":
			return `${baseUrl} came from WARREN_BASE_URL in the environment; check it ${serving}`;
		case "config-file":
			return `${baseUrl} came from the client config file (${clientConfigPath(env)}); check it ${serving}, or re-run \`warren login\` to replace it`;
		case "default":
			return `${baseUrl} is the built-in default, because no slot supplied one; set WARREN_BASE_URL or pass --url, ${serving}`;
		default:
			return `check WARREN_BASE_URL / --url ${serving}`;
	}
}

/** How the token slot reads in operator-facing output (warren-8807). */
function tokenSourceLabel(
	source: ClientConfigSource | undefined,
	env: EnvLike,
): string | undefined {
	switch (source) {
		case "flag":
			return "--token";
		case "env":
			return "WARREN_API_TOKEN in the environment";
		case "config-file":
			// The path the resolution actually read, which honours
			// WARREN_CLIENT_CONFIG rather than asserting the default (warren-4f1b).
			return `the client config file (${clientConfigPath(env)})`;
		default:
			return undefined;
	}
}

async function authCheck(
	client: WarrenClient,
	tokenSource: ClientConfigSource | undefined,
	env: EnvLike,
): Promise<DoctorCheck> {
	const label = tokenSourceLabel(tokenSource, env);
	try {
		const who = await client.whoami();
		const admitted = `admitted as ${who.identity} (capabilities: ${who.capabilities.join(", ")})`;
		return {
			name: "auth_valid",
			ok: true,
			message: label === undefined ? admitted : `${admitted}, token from ${label}`,
		};
	} catch (err) {
		return {
			name: "auth_valid",
			ok: false,
			message: formatError(err),
			hint: authFailureHint(tokenSource, env),
		};
	}
}

async function versionCheck(client: WarrenClient, cliVersion: string): Promise<DoctorCheck> {
	try {
		const server = await client.version();
		if (server.version === cliVersion) {
			return { name: "version_match", ok: true, message: `cli and server both at ${cliVersion}` };
		}
		return {
			name: "version_match",
			ok: false,
			message: `cli is ${cliVersion} but server is ${server.version}`,
			hint: "upgrade the CLI (or the server) so both run the same version",
		};
	} catch (err) {
		return { name: "version_match", ok: false, message: formatError(err) };
	}
}

function finish(context: CliContext, checks: readonly DoctorCheck[]): RemoteDoctorResult {
	return emitDoctorReport(context, checks);
}
