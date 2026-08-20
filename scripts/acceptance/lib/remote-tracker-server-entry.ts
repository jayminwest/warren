/**
 * Acceptance server entry for scenario 43 (warren-53ea): boots the REAL
 * warren server with the issue-tracker seam swapped onto a RemoteTracker
 * pointing at an external warren-tracker/v1 container.
 *
 * Why a separate entry instead of warren-side per-project routing: the
 * falsification claim under test is "a project served over
 * warren-tracker/v1 dispatches and closes with ZERO seeds code in the
 * path". The swap must force no domain-code changes — every behavior
 * the scenario asserts flows through the IssueTracker seam alone. If
 * this entry ever needs a src/runs/ or src/plan-runs/ edit to pass,
 * the abstraction failed — treat that as a finding, not a fix.
 *
 * Env contract:
 *   WARREN_TRACKER_URL   — base URL of the tracker container (required)
 *   WARREN_TRACKER_TOKEN — optional bearer, forwarded on every request
 */

import { bootServer } from "../../../src/server/main/index.ts";
import { RemoteTracker } from "../../../src/tracker/remote/remote-tracker.ts";

const trackerUrl = process.env.WARREN_TRACKER_URL;
if (trackerUrl === undefined || trackerUrl === "") {
	console.error("remote-tracker-server-entry: WARREN_TRACKER_URL is required");
	process.exit(1);
}

const trackerToken = process.env.WARREN_TRACKER_TOKEN;
const tracker = new RemoteTracker({
	baseUrl: trackerUrl as string,
	...(trackerToken !== undefined && trackerToken !== "" ? { bearerToken: trackerToken } : {}),
});
// Boot-time version negotiation: a protocol mismatch refuses the boot,
// before the server accepts a single request.
await tracker.connect();

bootServer({ issueTracker: tracker }).catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`warren: ${message}`);
	process.exit(1);
});
