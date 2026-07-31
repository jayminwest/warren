/**
 * `warren add-project <git-url>` — clone a GitHub repo into the projects
 * root and persist a row. Thin wrapper around `addProject` from
 * `projects/manage.ts`; same atomicity contract (row + dir on disk, or
 * neither). Maps `--default-branch` to the optional override the cloner
 * accepts.
 */

import type { ProjectsRepo } from "../../db/repos/projects.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import { addProject } from "../../projects/index.ts";
import type { PublicAllowlist } from "../../projects/public-allowlist.ts";
import type { CliContext } from "../output.ts";
import { formatError, writeJsonLine } from "../output.ts";

export interface AddProjectArgs {
	readonly gitUrl: string;
	readonly defaultBranch?: string;
}

export interface AddProjectDeps {
	readonly projects: ProjectsRepo;
	readonly projectsConfig: ProjectsConfig;
	/**
	 * Public-instance allowlist (warren-ce9b), forwarded into `addProject`
	 * so the CLI enforces the same registration gate as `POST /projects`
	 * (warren-0883). `undefined` (token mode) ⇒ no restriction.
	 */
	readonly publicAllowlist?: PublicAllowlist;
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
		return { exitCode: 2 };
	}

	try {
		const row = await addProject({
			repo: deps.projects,
			config: deps.projectsConfig,
			gitUrl: args.gitUrl,
			...(deps.publicAllowlist !== undefined ? { publicAllowlist: deps.publicAllowlist } : {}),
			...(args.defaultBranch !== undefined && args.defaultBranch !== ""
				? { defaultBranch: args.defaultBranch }
				: {}),
			spawn: context.spawn,
			...(context.now !== undefined ? { now: context.now } : {}),
		});
		writeJsonLine(context.stdio.stdout, {
			ok: true,
			project: {
				id: row.id,
				gitUrl: row.gitUrl,
				localPath: row.localPath,
				defaultBranch: row.defaultBranch,
				addedAt: row.addedAt,
			},
		});
		return { exitCode: 0 };
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: 1 };
	}
}
