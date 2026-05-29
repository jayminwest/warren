import type { SpawnFn, SpawnResult } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";

export const CFG: ProjectsConfig = { root: "/data/projects", gitBinary: "git" };

export interface Recorded {
	cmd: readonly string[];
	cwd: string;
}

export function recorder(handler: (cmd: readonly string[]) => SpawnResult): {
	spawn: SpawnFn;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const spawn: SpawnFn = async (cmd, opts) => {
		calls.push({ cmd, cwd: opts.cwd });
		return handler(cmd);
	};
	return { spawn, calls };
}

export function ok(stdout = ""): SpawnResult {
	return { stdout, stderr: "", exitCode: 0 };
}
