import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../registry/schema.ts";
import { RunSpawnError } from "./errors.ts";
import { buildSeedFiles, type HttpWorkspaceFile } from "./seed.ts";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "refactor-bot",
		version: 3,
		sections: { system: "be a refactor agent", ...(overrides.sections ?? {}) },
		resolvedFrom: ["base-coding-agent"],
		frontmatter: {},
		...overrides,
	};
}

function byPath(files: readonly HttpWorkspaceFile[]): Map<string, HttpWorkspaceFile> {
	return new Map(files.map((f) => [f.path, f]));
}

describe("buildSeedFiles", () => {
	test("emits the rendered agent envelope at .canopy/agent.json", () => {
		const result = buildSeedFiles(makeAgent());
		const map = byPath(result.files);
		expect(result.canopyPath).toBe(".canopy/agent.json");
		const entry = map.get(".canopy/agent.json");
		expect(entry).toBeDefined();
		const parsed = JSON.parse(entry?.contents ?? "");
		expect(parsed.name).toBe("refactor-bot");
		expect(parsed.sections.system).toBe("be a refactor agent");
	});

	test("groups expertise_seed by domain into .mulch/expertise/<domain>.jsonl", () => {
		const seed = [
			'{"type":"convention","domain":"refactor","content":"a"}',
			'{"type":"failure","domain":"refactor","description":"x","resolution":"y"}',
			'{"type":"convention","domain":"build","content":"b"}',
			"",
			"   ",
		].join("\n");
		const result = buildSeedFiles(makeAgent({ sections: { system: "s", expertise_seed: seed } }));
		const map = byPath(result.files);

		expect(result.mulchDomains).toEqual(["build", "refactor"]);
		expect(map.get(".mulch/expertise/refactor.jsonl")?.contents).toBe(
			`${[
				'{"type":"convention","domain":"refactor","content":"a"}',
				'{"type":"failure","domain":"refactor","description":"x","resolution":"y"}',
			].join("\n")}\n`,
		);
		expect(map.get(".mulch/expertise/build.jsonl")?.contents).toBe(
			'{"type":"convention","domain":"build","content":"b"}\n',
		);
	});

	test("rejects malformed expertise_seed lines with RunSpawnError", () => {
		expect(() =>
			buildSeedFiles(makeAgent({ sections: { system: "s", expertise_seed: "not json" } })),
		).toThrow(RunSpawnError);
	});

	test("rejects expertise_seed lines without a non-empty domain", () => {
		expect(() =>
			buildSeedFiles(makeAgent({ sections: { system: "s", expertise_seed: '{"type":"x"}' } })),
		).toThrow(RunSpawnError);
	});

	test("emits the workflow body verbatim at .seeds/workflow.txt", () => {
		const wf = "template: refactor";
		const result = buildSeedFiles(makeAgent({ sections: { system: "s", workflow: wf } }));
		const map = byPath(result.files);
		expect(result.workflowPath).toBe(".seeds/workflow.txt");
		expect(map.get(".seeds/workflow.txt")?.contents).toBe("template: refactor\n");
	});

	test("preserves a workflow body that already ends with a newline", () => {
		const result = buildSeedFiles(
			makeAgent({ sections: { system: "s", workflow: "template: refactor\n" } }),
		);
		expect(byPath(result.files).get(".seeds/workflow.txt")?.contents).toBe("template: refactor\n");
	});

	test("returns null workflowPath and empty mulchDomains when those sections are absent", () => {
		const result = buildSeedFiles(makeAgent());
		expect(result.workflowPath).toBeNull();
		expect(result.mulchDomains).toEqual([]);
		expect(result.piSkills).toEqual([]);
		expect(result.piPrompts).toEqual([]);
		expect(result.piExtensions).toEqual([]);
		// Only the canopy envelope drops when no optional sections are present.
		expect(result.files.map((f) => f.path)).toEqual([".canopy/agent.json"]);
	});

	test("emits pi_skills JSONL lines at .pi/skills/<name>/SKILL.md", () => {
		const section = [
			JSON.stringify({ name: "refactor", body: "# Refactor\nguidance here" }),
			JSON.stringify({ name: "review", body: "# Review\nchecklist" }),
		].join("\n");
		const result = buildSeedFiles(makeAgent({ sections: { system: "s", pi_skills: section } }));
		const map = byPath(result.files);

		expect(result.piSkills).toEqual(["refactor", "review"]);
		expect(map.get(".pi/skills/refactor/SKILL.md")?.contents).toBe("# Refactor\nguidance here\n");
		expect(map.get(".pi/skills/review/SKILL.md")?.contents).toBe("# Review\nchecklist\n");
	});

	test("preserves a body that already ends with a newline (pi_skills)", () => {
		const section = JSON.stringify({ name: "x", body: "body\n" });
		const result = buildSeedFiles(makeAgent({ sections: { system: "s", pi_skills: section } }));
		expect(byPath(result.files).get(".pi/skills/x/SKILL.md")?.contents).toBe("body\n");
	});

	test("emits pi_prompts JSONL lines at .pi/prompts/<name>.md", () => {
		const section = [
			JSON.stringify({ name: "summary", body: "Summarize the diff." }),
			JSON.stringify({ name: "deep-dive", body: "Investigate root cause." }),
		].join("\n");
		const result = buildSeedFiles(makeAgent({ sections: { system: "s", pi_prompts: section } }));
		const map = byPath(result.files);

		expect(result.piPrompts).toEqual(["deep-dive", "summary"]);
		expect(map.get(".pi/prompts/summary.md")?.contents).toBe("Summarize the diff.\n");
		expect(map.get(".pi/prompts/deep-dive.md")?.contents).toBe("Investigate root cause.\n");
	});

	test("rejects malformed pi_skills lines with RunSpawnError", () => {
		expect(() =>
			buildSeedFiles(makeAgent({ sections: { system: "s", pi_skills: "not json" } })),
		).toThrow(RunSpawnError);
	});

	test("rejects pi_skills lines without a non-empty name", () => {
		expect(() =>
			buildSeedFiles(
				makeAgent({
					sections: { system: "s", pi_skills: JSON.stringify({ body: "x" }) },
				}),
			),
		).toThrow(RunSpawnError);
	});

	test("rejects pi_skills lines without a string body", () => {
		expect(() =>
			buildSeedFiles(
				makeAgent({
					sections: { system: "s", pi_skills: JSON.stringify({ name: "x" }) },
				}),
			),
		).toThrow(RunSpawnError);
	});

	test("rejects pi_skills names containing path separators or traversal", () => {
		expect(() =>
			buildSeedFiles(
				makeAgent({
					sections: {
						system: "s",
						pi_skills: JSON.stringify({ name: "../escape", body: "x" }),
					},
				}),
			),
		).toThrow(RunSpawnError);
	});

	test("rejects duplicate pi_skills names", () => {
		const dup = [
			JSON.stringify({ name: "x", body: "a" }),
			JSON.stringify({ name: "x", body: "b" }),
		].join("\n");
		expect(() => buildSeedFiles(makeAgent({ sections: { system: "s", pi_skills: dup } }))).toThrow(
			RunSpawnError,
		);
	});

	test("emits pi_extensions JSONL lines at .pi/extensions/<name>.ts", () => {
		const section = [
			JSON.stringify({ name: "propose-intent", body: "export default (pi) => {};" }),
			JSON.stringify({ name: "audit", body: "export default (pi) => { pi.x(); };" }),
		].join("\n");
		const result = buildSeedFiles(makeAgent({ sections: { system: "s", pi_extensions: section } }));
		const map = byPath(result.files);

		expect(result.piExtensions).toEqual(["audit", "propose-intent"]);
		expect(map.get(".pi/extensions/propose-intent.ts")?.contents).toBe(
			"export default (pi) => {};\n",
		);
		expect(map.get(".pi/extensions/audit.ts")?.contents).toBe(
			"export default (pi) => { pi.x(); };\n",
		);
	});

	test("preserves a body that already ends with a newline (pi_extensions)", () => {
		const section = JSON.stringify({ name: "x", body: "export default () => {};\n" });
		const result = buildSeedFiles(makeAgent({ sections: { system: "s", pi_extensions: section } }));
		expect(byPath(result.files).get(".pi/extensions/x.ts")?.contents).toBe(
			"export default () => {};\n",
		);
	});

	test("rejects malformed pi_extensions lines with RunSpawnError", () => {
		expect(() =>
			buildSeedFiles(makeAgent({ sections: { system: "s", pi_extensions: "not json" } })),
		).toThrow(RunSpawnError);
	});

	test("rejects pi_extensions lines without a string body", () => {
		expect(() =>
			buildSeedFiles(
				makeAgent({
					sections: { system: "s", pi_extensions: JSON.stringify({ name: "x" }) },
				}),
			),
		).toThrow(RunSpawnError);
	});

	test("rejects pi_extensions names containing path separators or traversal", () => {
		expect(() =>
			buildSeedFiles(
				makeAgent({
					sections: {
						system: "s",
						pi_extensions: JSON.stringify({ name: "../escape", body: "x" }),
					},
				}),
			),
		).toThrow(RunSpawnError);
	});

	test("rejects duplicate pi_extensions names", () => {
		const dup = [
			JSON.stringify({ name: "x", body: "a" }),
			JSON.stringify({ name: "x", body: "b" }),
		].join("\n");
		expect(() =>
			buildSeedFiles(makeAgent({ sections: { system: "s", pi_extensions: dup } })),
		).toThrow(RunSpawnError);
	});

	test("rejects malformed pi_prompts lines with RunSpawnError", () => {
		expect(() =>
			buildSeedFiles(
				makeAgent({
					sections: {
						system: "s",
						pi_prompts: `${JSON.stringify({ name: "good", body: "ok" })}\n}{garbage`,
					},
				}),
			),
		).toThrow(RunSpawnError);
	});

	test("all emitted paths are workspace-relative (no leading slash)", () => {
		const section = JSON.stringify({ name: "x", body: "y" });
		const result = buildSeedFiles(
			makeAgent({
				sections: {
					system: "s",
					workflow: "wf",
					expertise_seed: '{"type":"convention","domain":"d","content":"c"}',
					pi_skills: section,
					pi_prompts: section,
					pi_extensions: section,
				},
			}),
		);
		for (const file of result.files) {
			expect(file.path.startsWith("/")).toBe(false);
			expect(file.path.startsWith(".")).toBe(true);
		}
	});
});
