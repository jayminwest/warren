import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSeedAgentsFromFile, SEED_AGENTS_FILE_ENV, SeedAgentsFileError } from "./seed-file.ts";

const VALID_AGENT = {
	name: "stub-shell",
	version: 1,
	sections: { system: "You are a stub." },
	resolvedFrom: ["acceptance:stub-shell"],
	frontmatter: { source: "builtin", runtime: "stub-shell" },
};

async function withTempFile(
	contents: string | undefined,
	fn: (path: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "warren-seed-file-test-"));
	try {
		const path = join(dir, "agents.json");
		if (contents !== undefined) await writeFile(path, contents);
		await fn(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("loadSeedAgentsFromFile", () => {
	test("parses a valid seed-agents file", async () => {
		await withTempFile(JSON.stringify([VALID_AGENT]), async (path) => {
			const agents = await loadSeedAgentsFromFile(path);
			expect(agents).toHaveLength(1);
			expect(agents[0]?.name).toBe("stub-shell");
			expect(agents[0]?.frontmatter.runtime).toBe("stub-shell");
		});
	});

	test("accepts an empty array", async () => {
		await withTempFile("[]", async (path) => {
			expect(await loadSeedAgentsFromFile(path)).toEqual([]);
		});
	});

	test("throws SeedAgentsFileError naming the env var when the file is missing", async () => {
		await withTempFile(undefined, async (path) => {
			const err = await loadSeedAgentsFromFile(path).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(SeedAgentsFileError);
			expect((err as Error).message).toContain(SEED_AGENTS_FILE_ENV);
			expect((err as Error).message).toContain(path);
		});
	});

	test("throws SeedAgentsFileError on malformed JSON", async () => {
		await withTempFile("{not json", async (path) => {
			const err = await loadSeedAgentsFromFile(path).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(SeedAgentsFileError);
			expect((err as Error).message).toContain("not valid JSON");
		});
	});

	test("throws SeedAgentsFileError with the issue path on schema violations", async () => {
		await withTempFile(JSON.stringify([{ name: "x" }]), async (path) => {
			const err = await loadSeedAgentsFromFile(path).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(SeedAgentsFileError);
			expect((err as Error).message).toContain("failed validation");
		});
	});

	test("rejects agent names outside the kebab grammar (warren-2b75)", async () => {
		for (const name of ["Stub-Shell", "stub shell", "-stub-shell", "foo/bar"]) {
			await withTempFile(JSON.stringify([{ ...VALID_AGENT, name }]), async (path) => {
				const err = await loadSeedAgentsFromFile(path).catch((e: unknown) => e);
				expect(err).toBeInstanceOf(SeedAgentsFileError);
				expect((err as Error).message).toContain("failed validation");
			});
		}
	});

	test("rejects a non-array payload", async () => {
		await withTempFile(JSON.stringify(VALID_AGENT), async (path) => {
			const err = await loadSeedAgentsFromFile(path).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(SeedAgentsFileError);
		});
	});
});
