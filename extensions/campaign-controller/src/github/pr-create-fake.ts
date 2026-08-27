/**
 * Deterministic in-memory `GithubPrCreateTransport` fake (Phase 2,
 * warren-84da). Records every intent it is handed so tests and the
 * acceptance negative probes can assert exactly how many creates were
 * attempted, and simulates the three upstream outcomes: created,
 * "already exists", and a transport loss whose outcome is unknown.
 */

import {
	GithubPrAlreadyExistsError,
	type GithubPrCreateResult,
	type GithubPrCreateTransport,
	GithubPrCreateUncertainError,
} from "./pr-create.ts";
import type { CrossForkPullRequestIntent } from "./pr-request.ts";

type FakeOutcome = { kind: "create" } | { kind: "already_exists" } | { kind: "uncertain" };

export class FakeGithubPrCreator implements GithubPrCreateTransport {
	/** Every intent handed to the fake, oldest first. */
	readonly received: CrossForkPullRequestIntent[] = [];
	private nextNumber: number;
	private readonly queue: FakeOutcome[] = [];

	constructor(options: { firstPrNumber?: number } = {}) {
		this.nextNumber = options.firstPrNumber ?? 4242;
	}

	/** Queue an "already exists" refusal for the next create. */
	refuseNextAsAlreadyExists(): this {
		this.queue.push({ kind: "already_exists" });
		return this;
	}

	/** Queue a transport loss (unknown outcome) for the next create. */
	loseNextResponse(): this {
		this.queue.push({ kind: "uncertain" });
		return this;
	}

	async createPullRequest(intent: CrossForkPullRequestIntent): Promise<GithubPrCreateResult> {
		this.received.push(intent);
		const outcome = this.queue.shift() ?? { kind: "create" };
		if (outcome.kind === "already_exists") {
			throw new GithubPrAlreadyExistsError(
				`fake: a pull request already exists for head ${intent.body.head}`,
				intent.url,
			);
		}
		if (outcome.kind === "uncertain") {
			throw new GithubPrCreateUncertainError(
				`fake: transport failed after the request may have been sent for ${intent.url}`,
				{ path: intent.url },
			);
		}
		const prNumber = this.nextNumber;
		this.nextNumber += 1;
		return {
			prNumber,
			prUrl: `https://github.com/${repoOf(intent.url)}/pull/${prNumber}`,
			nodeId: `PR_fake_${prNumber}`,
		};
	}
}

function repoOf(url: string): string {
	const match = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url);
	return match?.[1] ?? "unknown/unknown";
}
