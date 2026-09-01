/**
 * Shared fixture for the Azure DevOps arm's tests: a forge bound to the
 * in-memory stub server plus the repo ref its clone-URL grammar yields.
 */

import { AdoForge } from "./provider.ts";
import { stubAdoServer } from "./stub-server.ts";

export const CLONE_URL = "https://dev.azure.com/acme/Widgets/_git/widget";

export function setup(seed?: Parameters<typeof stubAdoServer>[0]) {
	const stub = stubAdoServer(seed);
	const forge = new AdoForge({ token: "test-pat", fetch: stub.fetch });
	const ref = forge.parseRepoRef(CLONE_URL);
	if (ref === null) throw new Error("parseRepoRef rejected its own grammar");
	return { forge, ref, stub };
}
