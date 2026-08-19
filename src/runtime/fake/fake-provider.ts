/**
 * Test-only `RuntimeProvider` fake (warren-ea0a, plan pl-3007). The suite
 * used to drive the retired legacy burrow-backed LocalProvider mode through
 * stubbed burrow HTTP (`makeSandboxClient` helpers over `src/burrow-client/`).
 * With the facade and the `@os-eco/burrow-cli` dependency gone, this module
 * is the semantic replacement: a contract-typed provider with plan-driven
 * canned behavior.
 *
 * Calls are still recorded in the historical `{method, path, body}` shape,
 * and `create` still maps the neutral `RunSpec` onto the two request bodies
 * the legacy mode produced (the `buildBurrowsUpInput` / `buildRunsCreateInput`
 * mapping lifted out of the deleted `src/runtime/local/legacy-create.ts`).
 * That keeps the long-standing spawn/handler assertions — which pin WHAT the
 * provider boundary is told, not which wire protocol carries it — in their
 * original form.
 */

import { collectProviderEnv } from "../../core/providers.ts";
import type { ReapExec, ReapFs } from "../../runs/reap/types.ts";
import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import { loopbackApiUrl } from "../../runs/spawn/callback-env.ts";
import type {
	FinalizeIntent,
	FinalizeResult,
	Message,
	NormalizedEvent,
	OutboundMessage,
	RunHandle,
	RunSpec,
	RunStatus,
	RuntimeCapabilities,
	RuntimeProvider,
	StreamOpts,
	TeardownResult,
	WorkspaceInfo,
} from "../contract.ts";
import { RuntimeProviderError, RuntimeRunNotFoundError } from "../errors.ts";
import { finalizeLocalWorkspace } from "../local/finalize.ts";
import { LOCAL_PROVIDER_CAPABILITIES } from "../local/provider.ts";

/** One recorded provider-boundary call, in the historical request shape. */
export interface FakeProviderCall {
	method: string;
	path: string;
	body: unknown;
}

/** Canned behavior knobs for {@link FakeProvider}. */
export interface FakeProviderPlan {
	/** Identity the fake hands back from `create` (historical fixture ids). */
	readonly sandboxId?: string;
	readonly providerRunId?: string;
	/** Workspace `workspaceInfo`/`finalize` resolve; `branch` rides along. */
	readonly workspacePath?: string | null;
	readonly branch?: string;
	/** `create` records `POST /sandboxes` then throws this (provision failure). */
	readonly provisionError?: unknown;
	/**
	 * `create` records both calls plus the legacy self-rollback
	 * (`DELETE /sandboxes/:id`) then throws this (dispatch failure).
	 */
	readonly dispatchError?: unknown;
	/** Events `streamEvents` yields in order before ending. */
	readonly events?: readonly NormalizedEvent[];
	/** `streamEvents` throws this instead of streaming. */
	readonly streamError?: unknown;
	/** `status` returns this (default: a running snapshot with `exists:true`). */
	readonly statusValue?: RunStatus;
	/** `sendMessage` throws this (e.g. `RuntimeRunNotFoundError`). */
	readonly sendMessageError?: unknown;
	/** Overrides for the `Message` row `sendMessage` returns. */
	readonly message?: Partial<Message>;
	/** `cancel` throws this. */
	readonly cancelError?: unknown;
	/** `workspaceInfo` (and therefore `finalize`) throws this. */
	readonly workspaceInfoError?: unknown;
	/** Workspace-tracker reads for `finalize`; default: every file absent. */
	readonly readTracker?: (relPath: string) => Promise<string | null>;
	/** Disk/shell seams `finalize` runs the reap merge functions over. */
	readonly fs?: ReapFs;
	readonly exec?: ReapExec;
	/** `terminate` result overrides (counts default to 0/`deletedRuns:1`). */
	readonly teardown?: Partial<TeardownResult>;
}

const DEFAULT_SANDBOX_ID = "bur_aaaaaaaaaaaa";
const DEFAULT_PROVIDER_RUN_ID = "run_zzzzzzzzzzzz";
const DEFAULT_WORKSPACE_PATH = "/data/sandbox/ws";
const DEFAULT_BRANCH = "agent/refactor-bot/run-1";
const BUN_INSTALL_CACHE_DIR = "/tmp/bun-install-cache";

/**
 * A `RuntimeProvider` double. `capabilities` mirrors LocalProvider's (the
 * reference backend) so capability gates under test see the full feature set.
 */
export class FakeProvider implements RuntimeProvider {
	readonly capabilities: RuntimeCapabilities = LOCAL_PROVIDER_CAPABILITIES;
	/** Mirrors LocalProvider — FakeProvider is the local-shaped test double. */
	readonly kind = "local" as const;
	readonly calls: FakeProviderCall[];
	/** Writable in tests so a scenario can arm a failure after construction. */
	readonly plan: { -readonly [K in keyof FakeProviderPlan]: FakeProviderPlan[K] };
	private readonly serverEnv: EnvLike | undefined;
	private finalizeFs: ReapFs | undefined;
	private finalizeExec: ReapExec | undefined;

	constructor(plan: FakeProviderPlan = {}, serverEnv?: EnvLike, calls?: FakeProviderCall[]) {
		this.plan = plan;
		this.serverEnv = serverEnv;
		this.calls = calls ?? [];
	}

	/**
	 * Point `finalize`'s disk/shell seams at the test's fakes after
	 * construction (the `reapDeps(provider, {fs, exec})` shape).
	 */
	withFinalizeSeams(fs?: ReapFs, exec?: ReapExec): this {
		this.finalizeFs = fs;
		this.finalizeExec = exec;
		return this;
	}

	private get sandboxId(): string {
		return this.plan.sandboxId ?? DEFAULT_SANDBOX_ID;
	}

	/** Provision + dispatch, recording the legacy two-call shape. */
	create(spec: RunSpec): Promise<RunHandle> {
		const env = composeSandboxEnv(spec.env, this.serverEnv);
		this.calls.push({ method: "POST", path: "/sandboxes", body: sandboxUpBody(spec, env) });
		if (this.plan.provisionError !== undefined) throw this.plan.provisionError;
		this.calls.push({
			method: "POST",
			path: `/sandboxes/${this.sandboxId}/runs`,
			body: {
				agentId: spec.runtimeId,
				prompt: spec.prompt,
				...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
			},
		});
		if (this.plan.dispatchError !== undefined) {
			// The legacy mode owned the sandbox-half rollback on a partial
			// failure: best-effort destroy, then rethrow.
			this.calls.push({ method: "DELETE", path: `/sandboxes/${this.sandboxId}`, body: undefined });
			throw this.plan.dispatchError;
		}
		return Promise.resolve({
			runId: spec.runId,
			sandboxId: this.sandboxId,
			providerRunId: this.plan.providerRunId ?? DEFAULT_PROVIDER_RUN_ID,
		});
	}

	async *streamEvents(_handle: RunHandle, _opts?: StreamOpts): AsyncIterable<NormalizedEvent> {
		if (this.plan.streamError !== undefined) throw this.plan.streamError;
		for (const event of this.plan.events ?? []) yield event;
	}

	status(_handle: RunHandle): Promise<RunStatus> {
		return Promise.resolve(
			this.plan.statusValue ?? {
				phase: "running",
				exitCode: null,
				lastEventSeq: 0,
				lastEventTs: null,
				exists: true,
			},
		);
	}

	sendMessage(handle: RunHandle, msg: OutboundMessage): Promise<Message> {
		this.calls.push({
			method: "POST",
			path: `/sandboxes/${handle.sandboxId}/inbox`,
			body: msg,
		});
		if (this.plan.sendMessageError !== undefined) throw this.plan.sendMessageError;
		return Promise.resolve({
			id: "msg_aaaaaaaaaaaa",
			runId: null,
			body: msg.body,
			priority: msg.priority ?? "normal",
			fromActor: msg.fromActor ?? "operator",
			state: "unread",
			createdAt: "2026-05-08T12:00:10Z",
			deliveredAt: null,
			...this.plan.message,
		});
	}

	cancel(handle: RunHandle, reason?: string): Promise<void> {
		this.calls.push({
			method: "POST",
			path: `/runs/${handle.providerRunId}/cancel`,
			body: reason !== undefined ? { reason } : undefined,
		});
		if (this.plan.cancelError !== undefined) throw this.plan.cancelError;
		return Promise.resolve();
	}

	workspaceInfo(_handle: RunHandle): Promise<WorkspaceInfo> {
		if (this.plan.workspaceInfoError !== undefined) throw this.plan.workspaceInfoError;
		return Promise.resolve({
			workspacePath:
				this.plan.workspacePath === undefined ? DEFAULT_WORKSPACE_PATH : this.plan.workspacePath,
			branch: this.plan.branch ?? DEFAULT_BRANCH,
		});
	}

	async finalize(handle: RunHandle, intent: FinalizeIntent): Promise<FinalizeResult> {
		const info = await this.workspaceInfo(handle);
		if (info.workspacePath === null) {
			throw new RuntimeProviderError(
				`FakeProvider.finalize: sandbox ${handle.sandboxId} exposed no workspace path`,
				{ recoveryHint: "a run with no workspacePath cannot be finalized" },
			);
		}
		const fs = this.finalizeFs ?? this.plan.fs;
		const exec = this.finalizeExec ?? this.plan.exec;
		return finalizeLocalWorkspace(
			{
				workspacePath: info.workspacePath,
				readTracker: this.plan.readTracker ?? (async () => null),
			},
			intent,
			{
				...(fs !== undefined ? { fs } : {}),
				...(exec !== undefined ? { exec } : {}),
			},
		);
	}

	terminate(handle: RunHandle): Promise<TeardownResult> {
		this.calls.push({ method: "DELETE", path: `/sandboxes/${handle.sandboxId}`, body: undefined });
		return Promise.resolve({
			archived: false,
			deletedEvents: 0,
			deletedMessages: 0,
			deletedRuns: 1,
			...this.plan.teardown,
		});
	}
}

/** Convenience constructor mirroring the old `makeSandboxClient` helpers. */
export function makeFakeProvider(plan: FakeProviderPlan = {}, serverEnv?: EnvLike): FakeProvider {
	return new FakeProvider(plan, serverEnv);
}

/** A provider whose every read reports the run as gone (ghost-run tests). */
export function ghostProvider(): FakeProvider {
	return new FakeProvider({
		statusValue: {
			phase: "failed",
			exitCode: null,
			terminalReason: "lost",
			lastEventSeq: 0,
			lastEventTs: null,
			exists: false,
		},
		sendMessageError: new RuntimeRunNotFoundError("run is unknown to the backend", {
			recoveryHint: "reconcile the warren row as lost",
		}),
	});
}

/**
 * Merge the DOMAIN env with the provider's own plumbing, exactly as the
 * legacy mode did (lifted from `legacy-create.ts`): provider credentials
 * first, domain env wins on overlap, `BUN_INSTALL_CACHE_DIR` always, and
 * the loopback callback URL only when the domain supplied a token.
 */
function composeSandboxEnv(
	domainEnv: Record<string, string>,
	serverEnv: EnvLike | undefined,
): Record<string, string> {
	const env: Record<string, string> = {
		...collectProviderEnv(serverEnv ?? process.env),
		...domainEnv,
		BUN_INSTALL_CACHE_DIR,
	};
	const token = domainEnv.WARREN_API_TOKEN;
	if (token !== undefined && token !== "") {
		const url = loopbackApiUrl(serverEnv ?? process.env);
		if (url !== null) env.WARREN_API_URL = url;
	}
	return env;
}

/** The recorded `POST /sandboxes` body — the legacy provision mapping. */
function sandboxUpBody(spec: RunSpec, env: Record<string, string>): Record<string, unknown> {
	if (spec.hostClonePathHint === undefined || spec.hostClonePathHint === "") {
		throw new RuntimeProviderError(
			"LocalProvider.create requires spec.hostClonePathHint (the host clone projectRoot)",
			{
				recoveryHint:
					"the local backend materializes the workspace as a git worktree off the host " +
					"clone; supply hostClonePathHint on the RunSpec (K8s ignores it)",
			},
		);
	}
	return {
		projectRoot: spec.hostClonePathHint,
		originUrl: spec.originUrl,
		agents: [spec.runtimeId],
		branch: spec.branch,
		baseBranch: spec.baseBranch,
		network: spec.network,
		...(spec.seedFiles.length > 0 ? { seed: { files: spec.seedFiles.map(toWorkspaceFile) } } : {}),
		env,
	};
}

type WorkspaceFile = {
	path: string;
	contents: string;
	encoding?: "utf-8" | "base64";
	mode?: number;
};

function toWorkspaceFile(f: RunSpec["seedFiles"][number]): WorkspaceFile {
	return {
		path: f.path,
		contents: f.contents,
		...(f.encoding !== undefined ? { encoding: f.encoding as "utf-8" | "base64" } : {}),
		...(f.mode !== undefined ? { mode: f.mode } : {}),
	};
}
