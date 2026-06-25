import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { WARREN_CONFIG_DIR, WARREN_CONFIG_FILES } from "./config.ts";
import { WARREN_CONFIG_FILE_ERROR_CODES, WarrenConfigUnavailableError } from "./errors.ts";
import { type ExistsFn, loadWarrenConfig, type ReadFileFn } from "./load.ts";

const PROJECT = "/data/projects/owner/repo";
const TRIGGERS_PATH = join(PROJECT, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.triggers);
const DEFAULTS_PATH = join(PROJECT, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.defaults);
const CONFIG_PATH = join(PROJECT, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.config);
const PREVIEW_PATH = join(PROJECT, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.preview);
const PR_TEMPLATE_PATH = join(PROJECT, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.prTemplate);
const DIR_PATH = join(PROJECT, WARREN_CONFIG_DIR);

interface FsHarness {
	readonly exists: ExistsFn;
	readonly readFile: ReadFileFn;
}

function fs(files: Record<string, string>, opts?: { withDir?: boolean }): FsHarness {
	const withDir = opts?.withDir ?? Object.keys(files).length > 0;
	const present = new Set<string>([PROJECT, ...Object.keys(files)]);
	if (withDir) present.add(DIR_PATH);
	return {
		exists: (path) => present.has(path),
		readFile: async (path) => {
			const value = files[path];
			if (value === undefined) {
				throw new Error(`unexpected read: ${path}`);
			}
			return value;
		},
	};
}

describe("loadWarrenConfig", () => {
	test("project clone missing on disk → throws WarrenConfigUnavailableError", async () => {
		await expect(
			loadWarrenConfig({
				projectPath: PROJECT,
				exists: () => false,
				readFile: async () => "",
			}),
		).rejects.toBeInstanceOf(WarrenConfigUnavailableError);
	});

	test("no .warren/ directory → all fields null, no errors / warnings (bootstrap shape)", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({}),
		});
		expect(result.triggers).toBeNull();
		expect(result.defaults).toBeNull();
		expect(result.sourceFile).toBeNull();
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("empty .warren/ directory → all fields null, no errors / warnings", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({}, { withDir: true }),
		});
		expect(result.triggers).toBeNull();
		expect(result.defaults).toBeNull();
		expect(result.sourceFile).toBeNull();
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("valid triggers.yaml + valid config.yaml → both parsed, no errors / warnings", async () => {
		const triggers = `
- id: nightly-refactor
  kind: cron
  cron: "0 3 * * *"
  timezone: UTC
  seed: seeds-abc1
  role: refactor-bot
`;
		const configYaml = `
defaultRole: claude-code
defaultBranch: main
defaultPrompt: Read the issue, plan, execute.
`;
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [TRIGGERS_PATH]: triggers, [CONFIG_PATH]: configYaml }),
		});
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.triggers).toHaveLength(1);
		expect(result.triggers?.[0]?.id).toBe("nightly-refactor");
		expect(result.defaults?.defaultRole).toBe("claude-code");
		expect(result.defaults?.defaultBranch).toBe("main");
		expect(result.sourceFile).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.config}`);
	});

	test("legacy defaults.json with no config.yaml → parsed, emits deprecation warning", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[DEFAULTS_PATH]: JSON.stringify({ defaultRole: "claude-code", defaultBranch: "main" }),
			}),
		});
		expect(result.errors).toEqual([]);
		expect(result.defaults?.defaultRole).toBe("claude-code");
		expect(result.sourceFile).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.defaults}`);
		expect(result.warnings).toHaveLength(1);
		const warning = result.warnings[0];
		expect(warning?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.deprecated);
		expect(warning?.file).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.defaults}`);
		expect(warning?.message).toMatch(/warren config migrate/);
	});

	test("config.yaml present alongside legacy defaults.json → config.yaml wins, deprecation warning still fires", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[CONFIG_PATH]: "defaultRole: from-yaml\n",
				[DEFAULTS_PATH]: JSON.stringify({ defaultRole: "from-json", defaultBranch: "main" }),
			}),
		});
		expect(result.errors).toEqual([]);
		expect(result.defaults?.defaultRole).toBe("from-yaml");
		expect(result.defaults?.defaultBranch).toBeUndefined();
		expect(result.sourceFile).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.config}`);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.deprecated);
		expect(result.warnings[0]?.message).toMatch(/superseded/);
	});

	test("malformed YAML in triggers → triggers null, parseError entry, defaults still loads", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[TRIGGERS_PATH]: ":\n  - not: [valid: yaml",
				[CONFIG_PATH]: "defaultBranch: main\n",
			}),
		});
		expect(result.triggers).toBeNull();
		expect(result.defaults?.defaultBranch).toBe("main");
		expect(result.errors).toHaveLength(1);
		const entry = result.errors[0];
		expect(entry?.file).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.triggers}`);
		expect(entry?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.parseError);
	});

	test("schema-invalid triggers → triggers null, schemaError entry", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[TRIGGERS_PATH]: '- id: bad\n  kind: cron\n  cron: ""\n  seed: s\n  role: r\n',
			}),
		});
		expect(result.triggers).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.schemaError);
	});

	test("malformed YAML in config.yaml → defaults null, parseError entry, triggers still loads", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[TRIGGERS_PATH]: "[]",
				[CONFIG_PATH]: ":\n  - not: [valid: yaml",
			}),
		});
		expect(result.triggers).toEqual([]);
		expect(result.defaults).toBeNull();
		expect(result.sourceFile).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.config}`);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.parseError);
		expect(result.errors[0]?.file).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.config}`);
	});

	test("malformed JSON in legacy defaults.json → defaults null, parseError entry, deprecation still fires", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[TRIGGERS_PATH]: "[]",
				[DEFAULTS_PATH]: "{ not valid json",
			}),
		});
		expect(result.triggers).toEqual([]);
		expect(result.defaults).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.parseError);
		expect(result.errors[0]?.file).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.defaults}`);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.deprecated);
	});

	test("schema-invalid config.yaml → defaults null, schemaError entry", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[CONFIG_PATH]: "defaultRole: ''\n",
			}),
		});
		expect(result.defaults).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.schemaError);
	});

	test("both files malformed → two error entries, both fields null", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[TRIGGERS_PATH]: "- id: bad\n  kind: cron\n  cron: nope nope\n  seed: s\n  role: r\n",
				[CONFIG_PATH]: "defaultBranch: 42\n",
			}),
		});
		expect(result.triggers).toBeNull();
		expect(result.defaults).toBeNull();
		expect(result.errors).toHaveLength(2);
	});

	test("empty triggers file (yaml.load returns undefined) → empty array, no error", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [TRIGGERS_PATH]: "" }),
		});
		expect(result.triggers).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("empty config.yaml → empty defaults object, no error", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [CONFIG_PATH]: "" }),
		});
		expect(result.defaults).toEqual({});
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	// warren-7be9 / SPEC §11.L: malformed preview block surfaces in the per-file
	// errors envelope (mx-66d478) — same pattern as any other `.warren/` field.
	test("malformed preview block in config.yaml → defaults null, schemaError entry", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[CONFIG_PATH]: "preview:\n  type: server\n  command: bun run dev\n",
			}),
		});
		expect(result.defaults).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.schemaError);
		expect(result.errors[0]?.file).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.config}`);
		expect(result.errors[0]?.message).toMatch(/preview/);
	});

	test("valid preview block in config.yaml → parsed through to LoadedWarrenConfig", async () => {
		const configYaml = [
			"preview:",
			"  type: server",
			"  command: bun run dev",
			"  port: 3000",
			"  readiness_path: /healthz",
			"  idle_ttl: 30m",
			"  max_lifetime: 8h",
			"",
		].join("\n");
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [CONFIG_PATH]: configYaml }),
		});
		expect(result.errors).toEqual([]);
		expect(result.defaults?.preview).toBeDefined();
		if (result.defaults?.preview && result.defaults.preview.type === "server") {
			expect(result.defaults.preview.command).toBe("bun run dev");
			expect(result.defaults.preview.port).toBe(3000);
			expect(result.defaults.preview.idle_ttl).toBe("30m");
		}
	});

	// warren-5840: preview.yaml is the canonical home for the preview block.
	test("preview.yaml (standalone) → parsed and exposed via defaults.preview", async () => {
		const previewYaml = [
			"type: server",
			"command: bun run dev",
			"port: 4321",
			"readiness_path: /ready",
			"",
		].join("\n");
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [PREVIEW_PATH]: previewYaml }),
		});
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.defaults?.preview).toBeDefined();
		if (result.defaults?.preview && result.defaults.preview.type === "server") {
			expect(result.defaults.preview.command).toBe("bun run dev");
			expect(result.defaults.preview.port).toBe(4321);
		}
	});

	test("preview.yaml overrides preview block in config.yaml", async () => {
		const configYaml = [
			"defaultRole: claude-code",
			"preview:",
			"  type: server",
			"  command: from-config",
			"  port: 3000",
			"",
		].join("\n");
		const previewYaml = ["type: server", "command: from-preview-yaml", "port: 9999", ""].join("\n");
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [CONFIG_PATH]: configYaml, [PREVIEW_PATH]: previewYaml }),
		});
		expect(result.errors).toEqual([]);
		expect(result.defaults?.defaultRole).toBe("claude-code");
		if (result.defaults?.preview && result.defaults.preview.type === "server") {
			expect(result.defaults.preview.command).toBe("from-preview-yaml");
			expect(result.defaults.preview.port).toBe(9999);
		}
	});

	test("preview.yaml without config.yaml → synthesizes defaults envelope with preview only", async () => {
		const previewYaml = ["type: server", "command: bun run dev", "port: 3000", ""].join("\n");
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [PREVIEW_PATH]: previewYaml }),
		});
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.defaults).not.toBeNull();
		expect(result.defaults?.defaultRole).toBeUndefined();
		expect(result.defaults?.preview).toBeDefined();
	});

	test("schema-invalid preview.yaml → defaults preserved from config.yaml, errors entry", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[CONFIG_PATH]: "defaultRole: claude-code\n",
				[PREVIEW_PATH]: "type: server\ncommand: missing-port\n",
			}),
		});
		expect(result.defaults?.defaultRole).toBe("claude-code");
		expect(result.defaults?.preview).toBeUndefined();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.file).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.preview}`);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.schemaError);
	});

	// warren-bd49: .warren/pr-template.md overrides PR-body fragments.
	test("no pr-template.md → prTemplate null, no errors", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({}, { withDir: true }),
		});
		expect(result.prTemplate).toBeNull();
		expect(result.errors).toEqual([]);
	});

	test("valid pr-template.md → prTemplate populated with overrides", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[PR_TEMPLATE_PATH]: "## trailer\n\nReviewed-by: @team\n",
			}),
		});
		expect(result.errors).toEqual([]);
		expect(result.prTemplate).toEqual({ trailer: "Reviewed-by: @team" });
	});

	test("malformed pr-template.md (unknown fragment) → schemaError entry, prTemplate still parsed", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[PR_TEMPLATE_PATH]: "## summary\nok\n\n## summery\ntypo\n",
			}),
		});
		expect(result.prTemplate).toEqual({ summary: "ok" });
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.file).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.prTemplate}`);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.schemaError);
		expect(result.errors[0]?.message).toContain("summery");
	});

	test("unclosed preview markers in pr-template.md → schemaError entry", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[PR_TEMPLATE_PATH]: "## preview_url_or_placeholder\n<!-- warren:preview-start -->\nhello\n",
			}),
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.schemaError);
		expect(result.errors[0]?.message).toContain("warren:preview-");
	});

	test("readFile throws (e.g. EACCES) → recorded as parseError, no throw", async () => {
		const present = new Set<string>([PROJECT, DIR_PATH, TRIGGERS_PATH]);
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			exists: (path) => present.has(path),
			readFile: async () => {
				throw new Error("EACCES: permission denied");
			},
		});
		expect(result.triggers).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.parseError);
		expect(result.errors[0]?.message).toMatch(/EACCES/);
	});
});
