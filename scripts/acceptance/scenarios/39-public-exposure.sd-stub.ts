/**
 * The sd-binary stub for scenario 39 (warren-b754).
 *
 * The ready-plans route is `readPublic`, so the leak sweep reads it for
 * real — the boot needs a tracker to answer. `writeSdStub` drops a stub
 * executable answering every seeds CLI read with an empty envelope; the
 * sweep needs only a populated (empty) 200 body, and no other scenario
 * path reaches the tracker (the scheduler and plan-run coordinator are
 * held off via env ticks). Split from `39-public-exposure.ts` for the
 * 500-line budget (check:size).
 */

import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Write the stub into `scenarioRoot` and return its path (WARREN_SD_BINARY). */
export async function writeSdStub(scenarioRoot: string): Promise<string> {
	const sdStubPath = join(scenarioRoot, "sd-stub");
	await writeFile(
		sdStubPath,
		"#!/usr/bin/env bun\nconst a = process.argv.slice(2);\nconsole.log(JSON.stringify(" +
			"a.includes('plan') && a.includes('list') ? { success: true, plans: [] } : { success: true, issues: [] }));\n",
	);
	await chmod(sdStubPath, 0o755);
	return sdStubPath;
}
