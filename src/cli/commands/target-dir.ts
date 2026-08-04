/**
 * Shared `--project` / `--cwd` target-directory resolution for the CLI
 * commands that write into `.warren/` (`init`, `config-migrate`).
 *
 * Both commands resolve the directory the same way: an explicit `--cwd`
 * path must exist, and a `--project` id must resolve to a registered
 * project whose clone is still on disk. Extracted in warren-00df — the two
 * copies were byte-identical and grandfathered in the dups allowlist.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type WarrenClient, WarrenClientError } from "../../client/index.ts";
import { NotFoundError, ValidationError } from "../../core/errors.ts";

/** The `--project` / `--cwd` discriminator both commands accept. */
export type TargetDirArgs =
	| { readonly mode: "cwd"; readonly cwd: string }
	| { readonly mode: "project"; readonly projectId: string };

/**
 * Resolve the directory a command should treat as the project root.
 *
 * @throws ValidationError when an explicit `--cwd` path is empty or missing,
 *   or when the project's clone is gone from disk.
 * @throws NotFoundError when `--project` names no registered project.
 */
export async function resolveTargetDir(client: WarrenClient, args: TargetDirArgs): Promise<string> {
	if (args.mode === "cwd") {
		const cwd = args.cwd;
		if (cwd === "") {
			throw new ValidationError("--cwd path is empty");
		}
		const abs = isAbsolute(cwd) ? cwd : resolve(cwd);
		if (!existsSync(abs)) {
			throw new ValidationError(`target directory does not exist: ${abs}`);
		}
		return abs;
	}
	// warren-97a2: the project row comes from `GET /projects/:id` — the CLI
	// no longer opens the server's SQLite. Writing into the clone still only
	// makes sense on the host, which per D3 is the remote user pointed at
	// localhost.
	const row = await getProjectOrNull(client, args.projectId);
	if (row === null) {
		throw new NotFoundError(`project not found: ${args.projectId}`);
	}
	if (!existsSync(row.localPath)) {
		throw new ValidationError(`project clone missing on disk: ${row.localPath}`, {
			recoveryHint: "POST /projects/:id/refresh or re-add the project",
		});
	}
	return row.localPath;
}

/** `GET /projects/:id`, mapping a 404 to null (a missing project is a lookup miss, not a failure). */
export async function getProjectOrNull(
	client: WarrenClient,
	projectId: string,
): Promise<{ readonly localPath: string } | null> {
	try {
		return await client.getProject(projectId);
	} catch (err) {
		if (err instanceof WarrenClientError && err.status === 404) return null;
		throw err;
	}
}
