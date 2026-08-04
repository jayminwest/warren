/**
 * Shared reachability probe for the remote CLI commands (warren-00df).
 *
 * Every command that talks to a remote warren probes first, turning a down
 * server into a friendly `warren: <error>` stderr line instead of a raw
 * fetch stack. `plan-run` and `plan-status` carried identical copies of
 * this helper, grandfathered in the dups allowlist.
 */

import type { WarrenClient } from "../../client/index.ts";
import { type CliContext, formatError } from "../output.ts";

/**
 * Probe the remote warren, mapping an unreachable server to a stderr line.
 * Returns true when the server answered.
 */
export async function probeOrReport(
	context: CliContext,
	client: WarrenClient,
	probeTimeoutMs?: number,
): Promise<boolean> {
	try {
		await (probeTimeoutMs !== undefined ? client.probe(probeTimeoutMs) : client.probe());
		return true;
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return false;
	}
}

/**
 * The shared preamble of the remote plan-run commands (`plan status`,
 * `plan cancel`): a plan-run id is required, and the server must answer the
 * probe. Returns the failure result to return, or null when the command may
 * proceed.
 */
export async function guardRemotePlanRun(
	context: CliContext,
	client: WarrenClient,
	planRunId: string,
	probeTimeoutMs?: number,
): Promise<{ readonly exitCode: number } | null> {
	if (planRunId === "") {
		context.stdio.stderr.write("warren: plan-run id is required\n");
		return { exitCode: 2 };
	}
	if (!(await probeOrReport(context, client, probeTimeoutMs))) {
		return { exitCode: 1 };
	}
	return null;
}
