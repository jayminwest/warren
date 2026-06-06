import { describe, expect, test } from "bun:test";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { ConversationsRepo } from "./conversations.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { MessagesRepo } from "./messages.ts";
import { ProjectsRepo } from "./projects.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`MessagesRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const projects = new ProjectsRepo(adapter);
			const conversations = new ConversationsRepo(adapter);
			const repo = new MessagesRepo(adapter);
			const project = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			const conv = await conversations.create({ projectId: project.id });
			return { handle, repo, conversations, projects, projectId: project.id, convId: conv.id };
		};

		test("append auto-allocates monotonic seq per conversation", async () => {
			const { handle, repo, convId } = await open();
			try {
				const m1 = await repo.append({ conversationId: convId, role: "user", content: "hi" });
				const m2 = await repo.append({
					conversationId: convId,
					role: "assistant",
					content: "hello",
				});
				expect(m1.seq).toBe(1);
				expect(m2.seq).toBe(2);
				expect(m1.id.startsWith("msg_")).toBe(true);
				expect(await repo.maxSeq(convId)).toBe(2);
			} finally {
				await handle.close();
			}
		});

		test("listByConversation returns the transcript oldest-first", async () => {
			const { handle, repo, convId } = await open();
			try {
				await repo.append({ conversationId: convId, role: "user", content: "one" });
				await repo.append({ conversationId: convId, role: "assistant", content: "two" });
				await repo.append({ conversationId: convId, role: "user", content: "three" });
				const rows = await repo.listByConversation(convId);
				expect(rows.map((r) => r.content)).toEqual(["one", "two", "three"]);
				expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
			} finally {
				await handle.close();
			}
		});

		test("maxSeq is null for a conversation with no turns", async () => {
			const { handle, repo, convId } = await open();
			try {
				expect(await repo.maxSeq(convId)).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("append honors an explicit run_id back-link", async () => {
			const { handle, repo, convId } = await open();
			try {
				const m = await repo.append({
					conversationId: convId,
					role: "assistant",
					content: "from a run",
					runId: "run_xyz",
				});
				expect(m.runId).toBe("run_xyz");
			} finally {
				await handle.close();
			}
		});
	});
}

suite("sqlite");
if (isPostgresTestEnabled()) {
	suite("postgres");
}
