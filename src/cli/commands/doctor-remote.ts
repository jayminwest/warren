/**
 * `warren doctor` (client half, warren-97a2 / owner decision D3).
 *
 * Post-collapse, plain `warren doctor` checks the CLIENT's view of a
 * (possibly remote) warren: is the server reachable, does the configured
 * credential authenticate, and does the server version match the CLI's.
 * The deployment-side probes (bwrap, burrow socket, projects root, DB
 * reachability, per-project `.warren/` validity) only make sense on the
 * host warren is deployed on — they live behind `warren doctor --local`
 * in `./doctor.ts`.
 *
 * Checks emit one NDJSON `{name, ok, message?, hint?}` line each,
 * mirroring the local half; the command exits 0 when every check passes
 * and 1 otherwise.
 */

import type { WarrenClient } from "../../client/index.ts";
import { VERSION } from "../../index.ts";
import type { CliContext } from "../output.ts";
import { formatError } from "../output.ts";
import { type DoctorCheck, emitDoctorReport } from "./doctor.ts";

export interface RemoteDoctorArgs {
	/** Skip the auth check (`warren doctor --no-auth`, loopback dev mode). */
	readonly noAuth?: boolean;
}

export interface RemoteDoctorDeps {
	/** Remote warren client. Production wires `resolveWarrenClient(context.env, flags)`. */
	readonly client: WarrenClient;
	/** Override the probe timeout (tests). */
	readonly probeTimeoutMs?: number;
	/** Override the CLI version compared against the server (tests). */
	readonly cliVersion?: string;
}

export interface RemoteDoctorResult {
	readonly exitCode: number;
	readonly checks: readonly DoctorCheck[];
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
		checks.push({ name: "server_reachable", ok: true, message: deps.client.config.baseUrl });
	} catch (err) {
		checks.push({
			name: "server_reachable",
			ok: false,
			message: formatError(err),
			hint: "check WARREN_BASE_URL / --url and that `warren serve` is running",
		});
		return finish(context, checks);
	}

	// 2. Auth: `/whoami` is a gated route — a missing/stale token 401s here.
	if (args.noAuth === true) {
		checks.push({ name: "auth_valid", ok: true, message: "skipped (--no-auth)" });
	} else {
		checks.push(await authCheck(deps.client));
	}

	// 3. Version match: a skewed CLI speaks a wire shape the server may
	// have moved on from. Mismatch is a failure with an upgrade hint.
	checks.push(await versionCheck(deps.client, deps.cliVersion ?? VERSION));

	return finish(context, checks);
}

async function authCheck(client: WarrenClient): Promise<DoctorCheck> {
	try {
		const who = await client.whoami();
		return {
			name: "auth_valid",
			ok: true,
			message: `admitted as ${who.identity} (capabilities: ${who.capabilities.join(", ")})`,
		};
	} catch (err) {
		return {
			name: "auth_valid",
			ok: false,
			message: formatError(err),
			hint: "check WARREN_API_TOKEN / --token against the server's credential",
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
