/**
 * Shared `--cwd` target-directory resolution for the CLI commands that
 * write into `.warren/` (`init`, `config migrate`).
 *
 * warren-166d retired the `--project` arm: both commands now dispatch
 * project-targeted writes through server routes
 * (`POST /projects/:id/init`, `POST /projects/:id/config-migrate`) that
 * run where the clone actually lives, so the CLI no longer resolves a
 * server-side `localPath` against the CLI machine's filesystem. (The
 * earlier decision that "writing into the clone only makes sense on the
 * host" — D3, warren-97a2 — is what warren-166d reverses.) What remains
 * here is the local-filesystem path: an explicit `--cwd` must exist.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ValidationError } from "../../core/errors.ts";

/** The `--cwd` argument both commands accept. */
export interface TargetDirArgs {
	readonly cwd: string;
}

/**
 * Resolve the directory a command should treat as the project root.
 *
 * @throws ValidationError when the explicit `--cwd` path is empty or missing.
 */
export function resolveTargetDir(args: TargetDirArgs): string {
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
