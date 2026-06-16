import type { SpawnFn } from "../projects/clone.ts";

export const captureSpawnCalls = (
	results: Record<string, { stdout?: string; stderr?: string; exitCode: number }>,
): { spawn: SpawnFn; calls: { cmd: readonly string[]; cwd: string }[] } => {
	const calls: { cmd: readonly string[]; cwd: string }[] = [];
	const spawn: SpawnFn = async (cmd, opts) => {
		calls.push({ cmd, cwd: opts.cwd });
		const key = cmd[0] ?? "";
		const result = results[key] ?? results[Object.keys(results).find((k) => key.endsWith(k)) ?? ""];
		if (result === undefined) {
			throw new Error(`unexpected spawn: ${cmd.join(" ")}`);
		}
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.exitCode,
		};
	};
	return { spawn, calls };
};
