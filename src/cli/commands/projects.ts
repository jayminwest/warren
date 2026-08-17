/**
 * `warren projects` — list the projects registered on a warren server
 * (warren-e127).
 *
 * Before this command, finding a project id (needed by `warren run`,
 * `plan run`, etc.) meant falling back to raw `curl GET /projects` with
 * a bearer token. This is a one-shot GET through the SDK's
 * `listProjects`, with the same output contract as the rest of the CLI:
 * ndjson rows (one project per line, id/gitUrl/defaultBranch only) by
 * default for machines, `--output pretty` an aligned table for humans.
 * Auth failures map to the stable warren-b61e exit codes via
 * {@link commandFailure}.
 */

import type { WarrenClient } from "../../client/index.ts";
import type { ProjectRow } from "../../client/types.ts";
import type { CliContext, WriteSink } from "../output.ts";
import { commandFailure, writeJsonLine } from "../output.ts";
import { renderTable } from "../table.ts";

/** The trimmed per-row projection emitted by `warren projects`. */
export interface ProjectSummary {
	readonly id: string;
	readonly gitUrl: string;
	readonly defaultBranch: string;
}

export interface ProjectsDeps {
	readonly client: WarrenClient;
}

export interface ProjectsResult {
	readonly exitCode: number;
	readonly count?: number;
}

export async function runProjects(
	context: CliContext,
	deps: ProjectsDeps,
): Promise<ProjectsResult> {
	try {
		const { projects } = await deps.client.listProjects();
		const summaries = projects.map(toSummary);
		if ((context.output ?? "ndjson") === "pretty") {
			renderProjectsPretty(context.stdio.stdout, summaries);
		} else {
			for (const summary of summaries) {
				writeJsonLine(context.stdio.stdout, summary);
			}
		}
		return { exitCode: 0, count: summaries.length };
	} catch (err) {
		return commandFailure(context, err);
	}
}

function toSummary(project: ProjectRow): ProjectSummary {
	return { id: project.id, gitUrl: project.gitUrl, defaultBranch: project.defaultBranch };
}

/** Pretty renderer: one aligned row per project, or a friendly empty marker. */
function renderProjectsPretty(sink: WriteSink, projects: readonly ProjectSummary[]): void {
	const line = (text: string): void => sink.write(`${text}\n`);
	if (projects.length === 0) {
		line("(no projects registered)");
		return;
	}
	const header = ["id", "gitUrl", "defaultBranch"];
	const rows = projects.map((p) => [p.id, p.gitUrl, p.defaultBranch]);
	renderTable(sink, header, rows);
}
