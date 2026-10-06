/**
 * Shared fixture for the GitLab arm's tests: a forge bound to the
 * in-memory stub server plus the repo ref its clone-URL grammar yields.
 */

import { GitLabForge } from "./provider.ts";
import { DEFAULT_GITLAB_URL, type GitLabInstance, parseGitLabInstance } from "./repo-ref.ts";
import { stubGitLabServer } from "./stub-server.ts";

export const CLONE_URL = "https://gitlab.com/acme/platform/widget.git";

export function gitLabDotCom(): GitLabInstance {
	const instance = parseGitLabInstance(DEFAULT_GITLAB_URL);
	if (instance === null) throw new Error("the default GitLab URL must parse");
	return instance;
}

export function setup(seed?: Parameters<typeof stubGitLabServer>[0]) {
	const stub = stubGitLabServer(seed);
	const forge = new GitLabForge({
		instance: gitLabDotCom(),
		token: "glpat-test",
		fetch: stub.fetch,
	});
	const ref = forge.parseRepoRef(CLONE_URL);
	if (ref === null) throw new Error("parseRepoRef rejected its own grammar");
	return { forge, ref, stub };
}
