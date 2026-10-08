/**
 * Server entry for the ui-visual fixture boot (warren-010b): the REAL
 * warren server, booted through `bootServer`'s existing `now` seam with
 * the clock pinned to `WARREN_UI_VISUAL_NOW` (epoch ms). Mirrors the
 * scenario-43 precedent (`scripts/acceptance/lib/remote-tracker-server-entry.ts`).
 *
 * Unlike `src/server/main/index.ts`, this entry owns SIGTERM/SIGINT: it
 * calls `stop()` and exits 0, so the fixture boot's shutdown is clean
 * rather than a signal kill.
 */

import { bootServer } from "../../src/server/main/index.ts";

const raw = process.env.WARREN_UI_VISUAL_NOW ?? "";
const nowMs = Number(raw);
if (raw === "" || !Number.isFinite(nowMs)) {
	console.error("fixture-server-entry: WARREN_UI_VISUAL_NOW (epoch ms) is required");
	process.exit(1);
}

try {
	const handle = await bootServer({ now: () => new Date(nowMs) });
	let stopping = false;
	const shutdown = (): void => {
		if (stopping) return;
		stopping = true;
		handle.stop().then(
			() => process.exit(0),
			() => process.exit(1),
		);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
} catch (err) {
	console.error(`warren: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
