import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatPreviewUrl, previewApi, runsApi } from "@/api/client.ts";
import type { RunRow } from "@/api/types.ts";
import { isActivePreviewState } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { StatusIndicator } from "@/components/status-indicator.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { formatError } from "@/lib/format-error.ts";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";
import { formatPreviewStateLabel } from "@/pages/run-detail/preview-labels.ts";

/**
 * The Direction C run-detail side-column Preview panel (warren-8c85 /
 * pl-7e38 step 4), translated from docs/ui-revamp/screens/run-detail.jsx
 * while preserving the existing preview-environments feature exactly
 * (R-19 / docs/design/preview-environments.md, warren-c0b9): the same
 * config query (readOperator-gated so a spectator never fires a
 * guaranteed 403, warren-f53e), the same bearer-gated login handshake
 * (warren-e1b0 — button, not a token-bearing URL), and the same
 * idempotent teardown route. Visible only when the run row carries a
 * non-null `previewState`; operator affordances ride OperatorOnly.
 */
function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex gap-2.5">
			<span className="w-[82px] shrink-0 text-[10px] leading-3 text-(--color-text-3) md:w-[104px]">
				{label}
			</span>
			<span className="min-w-0 flex-1 font-mono text-[10px] leading-3 break-words text-(--color-text-2) md:text-[9px]">
				{children}
			</span>
		</div>
	);
}

function PreviewFacts({
	run,
	canonicalUrl,
	mode,
}: {
	run: RunRow;
	canonicalUrl: string | null;
	mode: "path" | "subdomain" | undefined;
}) {
	return (
		<>
			{canonicalUrl !== null ? (
				<div className="flex gap-2.5">
					<span className="w-[82px] shrink-0 text-[10px] leading-3 text-(--color-text-3) md:w-[104px]">
						url
					</span>
					<span className="min-w-0 flex-1 font-mono text-[10px] leading-3 break-all text-(--color-primary) md:text-[9px]">
						{canonicalUrl}
					</span>
				</div>
			) : null}
			{run.previewPort !== null ? (
				<FactRow label="port">
					{run.previewPort}
					{mode !== undefined ? ` · ${mode} mode` : ""}
				</FactRow>
			) : null}
			{run.previewStartedAt !== null ? (
				<FactRow label="started">{formatTimestamp(run.previewStartedAt)}</FactRow>
			) : null}
			{run.previewLastHitAt !== null ? (
				<FactRow label="last hit">{relativeTime(run.previewLastHitAt)}</FactRow>
			) : null}
		</>
	);
}

export function PreviewPanel({ run }: { run: RunRow }) {
	const state = run.previewState;
	const caps = useCapabilities();
	const previewConfig = useQuery({
		queryKey: ["preview", "config"],
		queryFn: ({ signal }) => previewApi.config(signal),
		// Deployment-wide config; only a warren restart changes it.
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		// `GET /preview/config` discloses WARREN_PREVIEW_HOST and is
		// readOperator — don't fire a guaranteed 403 for a spectator
		// (warren-f53e). Without it the panel drops the canonical URL,
		// which is the operator's affordance anyway.
		enabled: caps.can("readOperator"),
	});
	if (state === null) return null;
	const isActive = isActivePreviewState(state);
	const canonicalUrl =
		state === "live" && previewConfig.data !== undefined
			? formatPreviewUrl(run.id, previewConfig.data, window.location.origin)
			: null;
	const mode = previewConfig.data?.mode;

	return (
		<section className="flex shrink-0 flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
			<header className="flex h-[39px] shrink-0 items-center gap-2 border-b border-(--color-border) px-3">
				<h2 className="text-[11px] leading-[14px] font-semibold text-(--color-text)">Preview</h2>
				<span className="flex-1" />
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
					{formatPreviewStateLabel(state).toUpperCase()}
				</span>
			</header>
			<div className="flex flex-col gap-2 p-3">
				<StatusIndicator kind="preview" status={state} />
				<PreviewFacts run={run} canonicalUrl={canonicalUrl} mode={mode} />
				{state === "failed" && run.previewFailureMessage ? (
					<pre
						className="max-h-40 overflow-auto rounded-(--radius-sm) border border-(--color-border) bg-(--color-bg) p-2 font-mono text-[9px] leading-[13px] break-words whitespace-pre-wrap text-(--color-danger)"
						title="Sidecar stderr / readiness-probe failure tail"
					>
						{run.previewFailureMessage}
					</pre>
				) : null}
			</div>
			<OperatorOnly>
				{state === "live" || isActive ? (
					<div className="flex items-center gap-2 px-3 pb-3">
						{state === "live" ? <PreviewLoginButton runId={run.id} /> : null}
						{isActive ? <PreviewTeardownButton runId={run.id} mode={mode} /> : null}
					</div>
				) : null}
			</OperatorOnly>
		</section>
	);
}

/**
 * "Log in to preview" (the export's login affordance) — the warren-e1b0
 * handshake: the click POSTs the bearer-gated login, the browser stores
 * the `Set-Cookie` that response carries, and only then do we navigate
 * to the mode-correct URL the server returned. The tab opens
 * synchronously inside the click handler (a `window.open` issued from
 * an async continuation is popup-blocked); `opener` is nulled so the
 * preview (untrusted, agent-authored code) can't reach back into the
 * warren UI window.
 */
function PreviewLoginButton({ runId }: { runId: string }) {
	const login = useMutation({
		mutationFn: () => runsApi.previewLogin(runId),
	});
	const openPreview = () => {
		const tab = window.open("", "_blank");
		if (tab !== null) tab.opener = null;
		login.mutate(undefined, {
			onSuccess: ({ url }) => {
				if (tab !== null) tab.location.href = url;
				else window.location.href = url;
			},
			onError: () => tab?.close(),
		});
	};
	return (
		<div className="flex flex-col items-start gap-1">
			<button
				type="button"
				onClick={openPreview}
				disabled={login.isPending}
				title="Sign a preview session cookie and open the live preview"
				className="inline-flex h-[26px] items-center rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-surface-raised) px-2.5 text-[11px] leading-[14px] font-medium text-(--color-text) hover:bg-(--color-surface-hover)"
			>
				{login.isPending ? "Opening…" : "Log in to preview"}
			</button>
			{login.isError ? (
				<p className="font-mono text-[9px] leading-3 text-(--color-danger)">
					{formatError(login.error)}
				</p>
			) : null}
		</div>
	);
}

function PreviewTeardownButton({
	runId,
	mode,
}: {
	runId: string;
	mode: "path" | "subdomain" | undefined;
}) {
	const qc = useQueryClient();
	const teardown = useMutation({
		mutationFn: () => runsApi.previewTeardown(runId, { actor: "ui" }),
		onSettled: () => qc.invalidateQueries({ queryKey: ["runs", runId] }),
	});
	// Mode-aware tooltip (warren-016d): path-mode previews share the warren
	// host so the `warren_preview` cookie is scoped to `/p/<id>/` and stays
	// in the browser after teardown until the path is reused; subdomain-mode
	// previews retire the dedicated `run-<id>.<host>` origin entirely. Both
	// land on the same idempotent endpoint — the copy just sets expectations.
	const base = "Stop the preview sidecar and release the port";
	const title =
		mode === "path"
			? `${base}. /p/<run-id>/ returns 404 after teardown.`
			: mode === "subdomain"
				? `${base}; the subdomain returns 404.`
				: `${base}.`;
	return (
		<div className="flex flex-col items-start gap-1">
			<button
				type="button"
				onClick={() => teardown.mutate()}
				disabled={teardown.isPending}
				title={title}
				className="inline-flex h-[26px] items-center rounded-(--radius-sm) border border-(--color-border-strong) px-2.5 text-[11px] leading-[14px] font-medium text-(--color-danger) hover:bg-(--color-surface-hover)"
			>
				{teardown.isPending ? "Tearing down…" : "Tear down"}
			</button>
			{teardown.isError ? (
				<p className="font-mono text-[9px] leading-3 text-(--color-danger)">
					{teardown.error instanceof Error ? teardown.error.message : String(teardown.error)}
				</p>
			) : null}
			{teardown.isSuccess && teardown.data !== undefined ? (
				<p className="font-mono text-[9px] leading-3 text-(--color-muted-foreground)">
					{teardown.data.status}
				</p>
			) : null}
		</div>
	);
}
