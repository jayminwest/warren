/**
 * Repository for the `projects` table.
 *
 * Projects are GitHub repos cloned under /data/projects/<owner>/<name> (SPEC
 * §5). The repo only owns the row; cloning, default-branch detection, and
 * filesystem layout are Phase 4's domain.
 */

import { asc, eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { ProjectRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

export interface CreateProjectInput {
	id?: string;
	gitUrl: string;
	localPath: string;
	defaultBranch: string;
	/**
	 * Seeds opt-in flag (warren-9990 / pl-a258 step 1). Defaults to false
	 * when omitted; the column is NOT NULL.
	 */
	hasSeeds?: boolean;
	now?: Date;
}

export interface RecordRefreshInput {
	id: string;
	headSha: string;
	/**
	 * Latest probe outcome (warren-9990). Omitted means "leave the prior
	 * value" — refresh callers always supply it.
	 */
	hasSeeds?: boolean;
	now?: Date;
}

export class ProjectsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get projects() {
		return this.adapter.schema.projects;
	}

	async create(input: CreateProjectInput): Promise<ProjectRow> {
		const row: ProjectRow = {
			id: input.id ?? generateId("project"),
			gitUrl: input.gitUrl,
			localPath: input.localPath,
			defaultBranch: input.defaultBranch,
			addedAt: (input.now ?? new Date()).toISOString(),
			lastFetchedAt: null,
			lastHeadSha: null,
			hasSeeds: input.hasSeeds ?? false,
		};
		await this.adapter.runWrite(this.db.insert(this.projects).values(row));
		return row;
	}

	async recordRefresh(input: RecordRefreshInput): Promise<ProjectRow> {
		const lastFetchedAt = (input.now ?? new Date()).toISOString();
		const patch: {
			lastFetchedAt: string;
			lastHeadSha: string;
			hasSeeds?: boolean;
		} = {
			lastFetchedAt,
			lastHeadSha: input.headSha,
		};
		if (input.hasSeeds !== undefined) {
			patch.hasSeeds = input.hasSeeds;
		}
		await this.adapter.runWrite(
			this.db.update(this.projects).set(patch).where(eq(this.projects.id, input.id)),
		);
		return this.require(input.id);
	}

	async get(id: string): Promise<ProjectRow | null> {
		const row = await this.adapter.pickOne(
			this.db.select().from(this.projects).where(eq(this.projects.id, id)),
		);
		return row ?? null;
	}

	async require(id: string): Promise<ProjectRow> {
		const row = await this.get(id);
		if (!row) {
			throw new NotFoundError(`project not found: ${id}`, {
				recoveryHint: "GET /projects to list known ids",
			});
		}
		return row;
	}

	async findByGitUrl(gitUrl: string): Promise<ProjectRow | null> {
		const row = await this.adapter.pickOne(
			this.db.select().from(this.projects).where(eq(this.projects.gitUrl, gitUrl)),
		);
		return row ?? null;
	}

	async listAll(): Promise<ProjectRow[]> {
		return this.adapter.pickAll(
			this.db.select().from(this.projects).orderBy(asc(this.projects.addedAt)),
		);
	}

	async delete(id: string): Promise<void> {
		await this.adapter.runWrite(this.db.delete(this.projects).where(eq(this.projects.id, id)));
	}
}
