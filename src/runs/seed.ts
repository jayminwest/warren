/**
 * Pure builder that turns an `AgentDefinition` into the `.canopy/`,
 * `.mulch/`, `.seeds/`, `.pi/` workspace drops (SPEC §4.3 step 3, §11.A).
 *
 * Returns `HttpWorkspaceFile[]` with workspace-relative paths so the
 * caller can either thread the list into `HttpClient.burrows.up({ seed })`
 * (R-07 atomic provision-and-seed) or post-provision via
 * `HttpClient.files.write`. No side effects — same validation errors as
 * the prior writer, but the disk writes themselves move to the caller.
 *
 * Five drops:
 *
 *   `.canopy/agent.json` — the rendered AgentDefinition envelope. The
 *      harness (claude-code or sapling) reads whichever sections it
 *      needs; packaging the whole envelope avoids prematurely freezing
 *      a per-section file layout before harness expectations stabilize.
 *
 *   `.mulch/expertise/<domain>.jsonl` — one entry per `expertise_seed`
 *      line, grouped by the line's `domain` field. Format is canonical
 *      mulch record JSONL; bad lines (non-JSON, missing `domain`) throw
 *      `RunSpawnError` so the operator sees the schema break before the
 *      run starts.
 *
 *   `.seeds/workflow.txt` — the workflow body verbatim. Seeds tooling
 *      consumes it; warren is just the courier.
 *
 *   `.pi/skills/<name>/SKILL.md` — one file per `pi_skills` JSONL line
 *      `{name, body}`. Pi reads SKILL.md from each skill directory; the
 *      canopy section is one envelope-per-line so a single canopy
 *      section can ship many skills without inventing a new artifact
 *      type. Bad lines (non-JSON, missing/invalid `name` or `body`)
 *      throw `RunSpawnError`.
 *
 *   `.pi/prompts/<name>.md` — same JSONL `{name, body}` shape as
 *      pi_skills but flat (one .md per prompt, no per-prompt
 *      directory).
 *
 *   `.pi/extensions/<name>.ts` — same JSONL `{name, body}` shape as
 *      pi_prompts but flat .ts modules (extensions default-export a
 *      `(pi) => {…}` registration function). INERT until burrow drops
 *      `--no-extensions` for pi-chat; seeding alone is a no-op.
 */

import type { HttpWorkspaceFile } from "@os-eco/burrow-cli";
import { formatError } from "../core/errors.ts";
import type { AgentDefinition } from "../registry/schema.ts";
import { RunSpawnError } from "./errors.ts";

export type { HttpWorkspaceFile } from "@os-eco/burrow-cli";

export interface BuildSeedFilesResult {
	readonly files: readonly HttpWorkspaceFile[];
	readonly canopyPath: string;
	readonly mulchDomains: readonly string[];
	readonly workflowPath: string | null;
	readonly piSkills: readonly string[];
	readonly piPrompts: readonly string[];
	readonly piExtensions: readonly string[];
}

export function buildSeedFiles(agent: AgentDefinition): BuildSeedFilesResult {
	const files: HttpWorkspaceFile[] = [];

	const canopyPath = ".canopy/agent.json";
	files.push({
		path: canopyPath,
		contents: `${JSON.stringify(
			{
				name: agent.name,
				version: agent.version,
				sections: agent.sections,
				resolvedFrom: agent.resolvedFrom,
				frontmatter: agent.frontmatter,
			},
			null,
			2,
		)}\n`,
	});

	const { domains, files: mulchFiles } = buildExpertiseFiles(agent.sections.expertise_seed);
	files.push(...mulchFiles);

	const workflowFile = buildWorkflowFile(agent.sections.workflow);
	if (workflowFile !== null) files.push(workflowFile);

	const { names: piSkills, files: skillFiles } = buildPiArtifactFiles(
		agent.sections.pi_skills,
		"skill",
	);
	files.push(...skillFiles);

	const { names: piPrompts, files: promptFiles } = buildPiArtifactFiles(
		agent.sections.pi_prompts,
		"prompt",
	);
	files.push(...promptFiles);

	const { names: piExtensions, files: extensionFiles } = buildPiArtifactFiles(
		agent.sections.pi_extensions,
		"extension",
	);
	files.push(...extensionFiles);

	return {
		files,
		canopyPath,
		mulchDomains: domains,
		workflowPath: workflowFile?.path ?? null,
		piSkills,
		piPrompts,
		piExtensions,
	};
}

function buildExpertiseFiles(body: string | undefined): {
	domains: readonly string[];
	files: HttpWorkspaceFile[];
} {
	if (body === undefined || body.trim() === "") return { domains: [], files: [] };

	const grouped = new Map<string, string[]>();
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (raw === undefined) continue;
		const line = raw.trim();
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			throw new RunSpawnError(
				`expertise_seed line ${i + 1} is not valid JSON: ${formatError(err)}`,
				{ recoveryHint: "fix the canopy prompt's expertise_seed section" },
			);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new RunSpawnError(
				`expertise_seed line ${i + 1} is not a JSON object: ${truncate(line, 80)}`,
			);
		}
		const domain = (parsed as { domain?: unknown }).domain;
		if (typeof domain !== "string" || domain === "") {
			throw new RunSpawnError(`expertise_seed line ${i + 1} is missing a non-empty "domain" field`);
		}
		const bucket = grouped.get(domain) ?? [];
		bucket.push(line);
		grouped.set(domain, bucket);
	}

	const domains = [...grouped.keys()].sort();
	const files = domains.map((domain) => {
		const records = grouped.get(domain) ?? [];
		return { path: `.mulch/expertise/${domain}.jsonl`, contents: `${records.join("\n")}\n` };
	});
	return { domains, files };
}

function buildWorkflowFile(body: string | undefined): HttpWorkspaceFile | null {
	if (body === undefined || body.trim() === "") return null;
	return {
		path: ".seeds/workflow.txt",
		contents: body.endsWith("\n") ? body : `${body}\n`,
	};
}

type PiArtifactKind = "skill" | "prompt" | "extension";

function buildPiArtifactFiles(
	body: string | undefined,
	kind: PiArtifactKind,
): { names: readonly string[]; files: HttpWorkspaceFile[] } {
	if (body === undefined || body.trim() === "") return { names: [], files: [] };
	const sectionName = PI_ARTIFACT_SECTION[kind];

	const entries: Array<{ name: string; body: string }> = [];
	const seen = new Set<string>();
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (raw === undefined) continue;
		const line = raw.trim();
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			throw new RunSpawnError(
				`${sectionName} line ${i + 1} is not valid JSON: ${formatError(err)}`,
				{ recoveryHint: `fix the canopy prompt's ${sectionName} section` },
			);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new RunSpawnError(
				`${sectionName} line ${i + 1} is not a JSON object: ${truncate(line, 80)}`,
			);
		}
		const obj = parsed as { name?: unknown; body?: unknown };
		if (typeof obj.name !== "string" || obj.name === "") {
			throw new RunSpawnError(`${sectionName} line ${i + 1} is missing a non-empty "name" field`);
		}
		if (!isSafeArtifactName(obj.name)) {
			throw new RunSpawnError(
				`${sectionName} line ${i + 1} has unsafe "name" ${JSON.stringify(obj.name)} (no path separators, "." or "..")`,
			);
		}
		if (typeof obj.body !== "string") {
			throw new RunSpawnError(`${sectionName} line ${i + 1} is missing a string "body" field`);
		}
		if (seen.has(obj.name)) {
			throw new RunSpawnError(
				`${sectionName} line ${i + 1} duplicates name ${JSON.stringify(obj.name)}`,
			);
		}
		seen.add(obj.name);
		entries.push({ name: obj.name, body: obj.body });
	}

	if (entries.length === 0) return { names: [], files: [] };

	const files = entries.map((entry) => {
		return {
			path: piArtifactPath(kind, entry.name),
			contents: entry.body.endsWith("\n") ? entry.body : `${entry.body}\n`,
		};
	});
	const names = entries.map((e) => e.name).sort();
	return { names, files };
}

const PI_ARTIFACT_SECTION: Record<PiArtifactKind, string> = {
	skill: "pi_skills",
	prompt: "pi_prompts",
	extension: "pi_extensions",
};

function piArtifactPath(kind: PiArtifactKind, name: string): string {
	switch (kind) {
		case "skill":
			return `.pi/skills/${name}/SKILL.md`;
		case "prompt":
			return `.pi/prompts/${name}.md`;
		case "extension":
			return `.pi/extensions/${name}.ts`;
	}
}

function isSafeArtifactName(name: string): boolean {
	if (name === "." || name === "..") return false;
	if (name.includes("/") || name.includes("\\")) return false;
	if (name.includes("\0")) return false;
	return true;
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}…`;
}
