/**
 * `warren add-project <git-url>` — register a project on a (possibly
 * remote) warren server.
 *
 * Post-warren-97a2 (owner decision D3) this command is a thin client of
 * `POST /projects`: the server clones the repo into its projects root,
 * enforces the public-instance allowlist (warren-ce9b / warren-0883),
 * and persists the row. The CLI no longer opens a local SQLite handle
 * or re-implements any of that — it probes, POSTs, and prints the
 * created project row as NDJSON. Maps `--default-branch` to the optional
 * override the route accepts.
 */

import type { WarrenClient } from "../../client/index.ts";
import type { CliContext } from "../output.ts";
import {
	EXIT_SERVER_UNREACHABLE,
	EXIT_USAGE,
	exitCodeForError,
	formatError,
	writeResult,
} from "../output.ts";
import { probeOrReport } from "./probe.ts";

export interface AddProjectArgs {
	readonly gitUrl: string;
	readonly defaultBranch?: string;
}

export interface AddProjectDeps {
	/** Remote warren client. Production wires `resolveCommandClient(context, opts)`. */
	readonly client: WarrenClient;
	/** Override the probe timeout (tests). */
	readonly probeTimeoutMs?: number;
}

export interface AddProjectResult {
	readonly exitCode: number;
}

export async function runAddProject(
	context: CliContext,
	deps: AddProjectDeps,
	args: AddProjectArgs,
): Promise<AddProjectResult> {
	if (args.gitUrl === "") {
		context.stdio.stderr.write("warren: git-url is required\n");
		return { exitCode: EXIT_USAGE };
	}

	if (!(await probeOrReport(context, deps.client, deps.probeTimeoutMs))) {
		return { exitCode: EXIT_SERVER_UNREACHABLE };
	}

	try {
		const row = await deps.client.createProject({
			gitUrl: args.gitUrl,
			...(args.defaultBranch !== undefined && args.defaultBranch !== ""
				? { defaultBranch: args.defaultBranch }
				: {}),
		});
		writeResult(
			context,
			{
				ok: true,
				project: {
					id: row.id,
					gitUrl: row.gitUrl,
					localPath: row.localPath,
					defaultBranch: row.defaultBranch,
					addedAt: row.addedAt,
				},
			},
			`✔ project ${row.id} registered — ${row.gitUrl} (branch ${row.defaultBranch})`,
		);
		return { exitCode: 0 };
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: exitCodeForError(err) };
	}
}
