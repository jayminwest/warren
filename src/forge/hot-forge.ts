/**
 * Hot-swappable forge wrapper (warren-b504, plan pl-26f3 step 7).
 *
 * The forge is resolved ONCE at boot (warren-6c4c) and every consumer —
 * handlers, reap bridges, the plan-run coordinator, the CI-fixer —
 * captured that instance in a closure. Swapping the forge "in-process"
 * therefore cannot mean mutating `ServerDeps`: nothing would see it.
 *
 * Instead, when the opt-in App credential store is armed, boot wraps the
 * resolved forge in this delegating proxy and threads THE PROXY
 * everywhere it threaded the boot forge. `activateApp` swaps the
 * delegate; every consumer picks the new forge on its next call without
 * a restart. Consumers that need the concrete instance (the credential
 * heartbeat wiring) unwrap through `current`.
 *
 * This module stays forge-inward: constructing the `GitHubAppForge` and
 * owning the swap is forge business, and the `api.github.com` literal
 * never leaves `src/forge/**`.
 */

import type { Forge } from "./contract.ts";
import { type GitHubAppCredentials, GitHubAppForge } from "./github-app/provider.ts";

/**
 * The activation seam handlers consume: the credential store plus the
 * swappable forge it feeds. Present ONLY when the opt-in store is armed.
 */
export interface GitHubAppActivation {
	readonly store: import("./github-app/credential-store.ts").GitHubAppCredentialStore;
	readonly hotForge: HotForge;
}

/**
 * A `Forge` whose delegate can be swapped after boot. Implements the
 * whole contract by delegation — the `Parameters<...>` trick mirrors
 * `GitHubAppForge`'s own transport delegation so signatures cannot drift.
 */
export class HotForge implements Forge {
	private delegate: Forge;

	constructor(boot: Forge) {
		this.delegate = boot;
	}

	/** The forge currently answering. Read-only for consumers. */
	get current(): Forge {
		return this.delegate;
	}

	/** Whether an App activation has already swapped the delegate. */
	get activated(): boolean {
		return this.delegate instanceof GitHubAppForge;
	}

	/**
	 * Swap in a `GitHubAppForge` built from the completed credential
	 * triple. Returns the previous forge (the boot-resolved one) so the
	 * caller can log or compare. Throws only constructor validation
	 * errors (`ForgeConfigError` on an unparseable key) — fail loud, the
	 * same boot discipline, just later.
	 */
	activateApp(credentials: GitHubAppCredentials, options: { readonly fetch?: typeof fetch } = {}) {
		const previous = this.delegate;
		this.delegate = new GitHubAppForge({
			...credentials,
			...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
		});
		return previous;
	}

	get capabilities() {
		return this.delegate.capabilities;
	}

	parseRepoRef(cloneUrl: string): ReturnType<Forge["parseRepoRef"]> {
		return this.delegate.parseRepoRef(cloneUrl);
	}

	/**
	 * A getter, not a method: `repoLayout` is optional on the contract and
	 * its PRESENCE signals a layout-declaring forge, so this wrapper must
	 * mirror whatever the current delegate declares.
	 */
	get repoLayout(): Forge["repoLayout"] {
		const layout = this.delegate.repoLayout;
		return layout === undefined ? undefined : layout.bind(this.delegate);
	}

	gitCredential(ref: Parameters<Forge["gitCredential"]>[0]) {
		return this.delegate.gitCredential(ref);
	}

	openPullRequest(
		ref: Parameters<Forge["openPullRequest"]>[0],
		req: Parameters<Forge["openPullRequest"]>[1],
	) {
		return this.delegate.openPullRequest(ref, req);
	}

	findPullRequest(
		ref: Parameters<Forge["findPullRequest"]>[0],
		q: Parameters<Forge["findPullRequest"]>[1],
	) {
		return this.delegate.findPullRequest(ref, q);
	}

	getPullRequest(
		ref: Parameters<Forge["getPullRequest"]>[0],
		pr: Parameters<Forge["getPullRequest"]>[1],
	) {
		return this.delegate.getPullRequest(ref, pr);
	}

	setPullRequestBody(
		ref: Parameters<Forge["setPullRequestBody"]>[0],
		pr: Parameters<Forge["setPullRequestBody"]>[1],
		body: Parameters<Forge["setPullRequestBody"]>[2],
	) {
		return this.delegate.setPullRequestBody(ref, pr, body);
	}

	listChecks(ref: Parameters<Forge["listChecks"]>[0], commit: Parameters<Forge["listChecks"]>[1]) {
		return this.delegate.listChecks(ref, commit);
	}

	fetchJobLogTail(
		ref: Parameters<Forge["fetchJobLogTail"]>[0],
		jobId: Parameters<Forge["fetchJobLogTail"]>[1],
		maxBytes: Parameters<Forge["fetchJobLogTail"]>[2],
	) {
		return this.delegate.fetchJobLogTail(ref, jobId, maxBytes);
	}

	deleteBranch(
		ref: Parameters<Forge["deleteBranch"]>[0],
		branch: Parameters<Forge["deleteBranch"]>[1],
	) {
		return this.delegate.deleteBranch(ref, branch);
	}

	botIdentity(): ReturnType<Forge["botIdentity"]> {
		return this.delegate.botIdentity();
	}

	listInstallationRepos(): ReturnType<Forge["listInstallationRepos"]> {
		return this.delegate.listInstallationRepos();
	}
}
