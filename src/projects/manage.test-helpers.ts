import type { WarrenConfigCache } from "../warren-config/index.ts";
import type { CloneProjectResult, SpawnFn } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";

export const CFG: ProjectsConfig = {
	root: "/data/projects",
	gitBinary: "git",
};

export const NOOP_SPAWN: SpawnFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });

export interface RecordingCache extends WarrenConfigCache {
	readonly invalidations: readonly string[];
}

export function recordingCache(): RecordingCache {
	const invalidations: string[] = [];
	return {
		get invalidations() {
			return invalidations;
		},
		get: async () => ({
			triggers: null,
			defaults: null,
			prTemplate: null,
			sourceFile: null,
			errors: [],
			warnings: [],
		}),
		invalidate: (id: string) => {
			invalidations.push(id);
		},
		clear: () => {
			invalidations.length = 0;
		},
		size: () => 0,
	};
}

export function fakeClone(
	result: Partial<CloneProjectResult> = {},
): typeof import("./clone.ts").cloneProjectRepo {
	return async (input) => ({
		localPath: result.localPath ?? `${input.config.root}/${input.owner}/${input.name}`,
		defaultBranch: result.defaultBranch ?? input.defaultBranch ?? "main",
	});
}
