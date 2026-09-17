import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { WARREN_CONFIG_DIR, WARREN_CONFIG_FILES } from "./config.ts";
import { WARREN_CONFIG_FILE_ERROR_CODES } from "./errors.ts";
import { type ExistsFn, loadWarrenConfig, type ReadFileFn } from "./load.ts";
import {
	MAX_AUTO_MERGE_PROTECTED_PATH_CHARS,
	MAX_AUTO_MERGE_PROTECTED_PATHS,
} from "./pr-config.ts";
import { DefaultsConfigSchema, PrConfigSchema } from "./schema.ts";

/**
 * Per-project PR-delivery block (warren-6c5a, plan pl-92a3 step 4):
 * `pr.autoMerge` opts a project into warren-armed auto-merge. Absent block
 * means off; present it is `{ method, protectedPaths }` with squash / []
 * defaults. Nothing consumes it yet — these tests pin the config contract
 * the later pl-92a3 steps (arming policy, reap PR-open) build against.
 */
describe("DefaultsConfigSchema pr.autoMerge block", () => {
	test("leaves pr undefined when the block is omitted (auto-merge off)", () => {
		const parsed = DefaultsConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.pr).toBeUndefined();
	});

	test("accepts an empty pr block (autoMerge absent still means off)", () => {
		const parsed = PrConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.autoMerge).toBeUndefined();
	});

	test("applies the squash method and empty protectedPaths defaults to a bare block", () => {
		const parsed = DefaultsConfigSchema.safeParse({ pr: { autoMerge: {} } });
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.pr?.autoMerge).toEqual({ method: "squash", protectedPaths: [] });
		}
	});

	test("round-trips an explicit method and protectedPaths", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			pr: {
				autoMerge: {
					method: "rebase",
					protectedPaths: ["docs/design", "src/forge/**", ".github/"],
				},
			},
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.pr?.autoMerge).toEqual({
				method: "rebase",
				protectedPaths: ["docs/design", "src/forge/**", ".github/"],
			});
		}
	});

	test("accepts every documented merge method", () => {
		for (const method of ["squash", "merge", "rebase"] as const) {
			expect(PrConfigSchema.safeParse({ autoMerge: { method } }).success).toBe(true);
		}
	});

	test("rejects an unknown merge method", () => {
		expect(PrConfigSchema.safeParse({ autoMerge: { method: "fast-forward" } }).success).toBe(false);
	});

	test("rejects a non-string method", () => {
		expect(PrConfigSchema.safeParse({ autoMerge: { method: 1 } }).success).toBe(false);
	});

	test("rejects an empty protectedPaths entry", () => {
		expect(PrConfigSchema.safeParse({ autoMerge: { protectedPaths: [""] } }).success).toBe(false);
	});

	test("rejects a protectedPaths entry with a leading slash", () => {
		expect(
			PrConfigSchema.safeParse({ autoMerge: { protectedPaths: ["/docs/design"] } }).success,
		).toBe(false);
	});

	test("rejects protectedPaths entries that traverse upward", () => {
		for (const bad of ["..", "docs/../src", "a/b/../../.."]) {
			expect(PrConfigSchema.safeParse({ autoMerge: { protectedPaths: [bad] } }).success).toBe(
				false,
			);
		}
	});

	test("rejects a protectedPaths entry over the length bound", () => {
		expect(
			PrConfigSchema.safeParse({
				autoMerge: { protectedPaths: ["x".repeat(MAX_AUTO_MERGE_PROTECTED_PATH_CHARS + 1)] },
			}).success,
		).toBe(false);
	});

	test("rejects a protectedPaths list over the count bound", () => {
		const tooMany = Array.from(
			{ length: MAX_AUTO_MERGE_PROTECTED_PATHS + 1 },
			(_, i) => `dir-${i}`,
		);
		expect(PrConfigSchema.safeParse({ autoMerge: { protectedPaths: tooMany } }).success).toBe(
			false,
		);
	});

	test("rejects a non-array protectedPaths", () => {
		expect(PrConfigSchema.safeParse({ autoMerge: { protectedPaths: "docs/**" } }).success).toBe(
			false,
		);
	});

	test("rejects unknown keys inside autoMerge (strict)", () => {
		expect(PrConfigSchema.safeParse({ autoMerge: { method: "squash", merge: true } }).success).toBe(
			false,
		);
	});

	test("rejects unknown keys inside pr (strict)", () => {
		expect(PrConfigSchema.safeParse({ autoMerge: {}, draft: true }).success).toBe(false);
	});

	test("rejects the autoMerge true shorthand with the object-form hint", () => {
		const parsed = PrConfigSchema.safeParse({ autoMerge: true });
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			const message = parsed.error.issues.map((issue) => issue.message).join("; ");
			expect(message).toContain("pr.autoMerge must be an object");
			expect(message).toContain("true");
		}
	});
});

const PROJECT = "/data/projects/owner/repo";
const CONFIG_PATH = join(PROJECT, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.config);
const LEGACY_PATH = join(PROJECT, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.defaults);

/** In-memory FS matching the loader's injected `exists` / `readFile` seams. */
function fs(files: Record<string, string>): {
	readonly exists: ExistsFn;
	readonly readFile: ReadFileFn;
} {
	const present = new Set<string>([
		PROJECT,
		join(PROJECT, WARREN_CONFIG_DIR),
		...Object.keys(files),
	]);
	return {
		exists: (path) => present.has(path),
		readFile: async (path) => {
			const value = files[path];
			if (value === undefined) throw new Error(`unexpected read: ${path}`);
			return value;
		},
	};
}

describe("loadWarrenConfig pr.autoMerge round-trip", () => {
	test("surfaces the parsed block from config.yaml with defaults applied", async () => {
		const configYaml = `
pr:
  autoMerge:
    protectedPaths:
      - docs/design
      - src/forge/**
`;
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [CONFIG_PATH]: configYaml }),
		});
		expect(result.errors).toEqual([]);
		expect(result.defaults?.pr?.autoMerge).toEqual({
			method: "squash",
			protectedPaths: ["docs/design", "src/forge/**"],
		});
	});

	test("rejects a malformed block as a schema error with defaults null", async () => {
		const configYaml = `
pr:
  autoMerge: true
`;
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [CONFIG_PATH]: configYaml }),
		});
		expect(result.defaults).toBeNull();
		expect(result.errors).toHaveLength(1);
		const error = result.errors[0];
		if (error === undefined) throw new Error("expected a schema error entry");
		expect(error.file).toBe(".warren/config.yaml");
		expect(error.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.schemaError);
		expect(error.message).toContain("pr.autoMerge must be an object");
	});

	test("accepts the block through the legacy defaults.json path (same shared schema)", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [LEGACY_PATH]: '{"pr":{"autoMerge":{"method":"rebase"}}}' }),
		});
		expect(result.errors).toEqual([]);
		expect(result.defaults?.pr?.autoMerge).toEqual({ method: "rebase", protectedPaths: [] });
	});
});
