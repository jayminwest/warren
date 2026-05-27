// Shared fixtures for refresh.test.ts and its split sibling test files
// (refresh.project.test.ts, refresh.cross-tier.test.ts, refresh.cache.test.ts).
// Kept next to refresh.ts so it travels with the module under test.

import { CanopyClient, type SpawnFn, type SpawnResult } from "./canopy.ts";
import type { CanopyRegistryConfig } from "./config.ts";

export const CFG: CanopyRegistryConfig = {
	repoUrl: "https://example.com/agents.git",
	localDir: "/tmp/canopy-refresh",
	cnBinary: "cn",
	gitBinary: "git",
};

export const FAKE_CLONE = async () => ({ cloned: false, localDir: CFG.localDir });

type CommandHandler = { ok?: unknown; exit?: number; stderr?: string };

function respondFromHandler(handler: CommandHandler): SpawnResult {
	if (handler.exit !== undefined && handler.exit !== 0) {
		return {
			stdout: handler.ok !== undefined ? JSON.stringify(handler.ok) : "",
			stderr: handler.stderr ?? "",
			exitCode: handler.exit,
		};
	}
	return { stdout: JSON.stringify(handler.ok), stderr: "", exitCode: 0 };
}

function handleRender(name: string, responses: Record<string, CommandHandler>): SpawnResult {
	const handler = responses[name];
	if (!handler) {
		return { stdout: "", stderr: `unhandled render: ${name}`, exitCode: 2 };
	}
	return respondFromHandler(handler);
}

function handleShow(name: string, responses: Record<string, CommandHandler>): SpawnResult {
	const handler = responses[name];
	if (!handler) {
		// Default: structured "Prompt not found" envelope so the compose
		// resolver treats unknown names as absent at this tier.
		return {
			stdout: JSON.stringify({
				success: false,
				command: "show",
				error: `Prompt '${name}' not found`,
			}),
			stderr: "",
			exitCode: 1,
		};
	}
	return respondFromHandler(handler);
}

export function buildSpawn(
	listResp: unknown,
	renderResponses: Record<string, CommandHandler>,
	showResponses: Record<string, CommandHandler> = {},
): SpawnFn {
	return async (cmd) => {
		const sub = cmd[1];
		const name = cmd[2] as string;
		if (sub === "list") {
			return { stdout: JSON.stringify(listResp), stderr: "", exitCode: 0 };
		}
		if (sub === "render") return handleRender(name, renderResponses);
		if (sub === "show") return handleShow(name, showResponses);
		const result: SpawnResult = { stdout: "", stderr: "unexpected cmd", exitCode: 1 };
		return result;
	};
}

/** Build a structured `cn show --json` success envelope. */
export function showOk(
	name: string,
	body: {
		version?: number;
		sections?: Record<string, string>;
		extends?: string;
		mixins?: string[];
		frontmatter?: Record<string, unknown>;
	},
) {
	return {
		ok: {
			success: true,
			command: "show",
			prompt: {
				id: `canopy-${name}`,
				name,
				version: body.version ?? 1,
				sections: Object.entries(body.sections ?? {}).map(([n, b]) => ({ name: n, body: b })),
				...(body.extends !== undefined ? { extends: body.extends } : {}),
				...(body.mixins !== undefined ? { mixins: body.mixins } : {}),
				...(body.frontmatter !== undefined ? { frontmatter: body.frontmatter } : {}),
				status: "active",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		},
	};
}

/** Structured "Prompt 'X' not found" render error envelope. */
export function renderMissingParent(parentName: string) {
	return {
		exit: 1,
		ok: { success: false, command: "render", error: `Prompt "${parentName}" not found` },
	};
}

export function rendered(name: string, sections: Record<string, string>, version = 1) {
	return {
		success: true,
		command: "render",
		name,
		version,
		sections: Object.entries(sections).map(([n, body]) => ({ name: n, body })),
	};
}

export { CanopyClient };
