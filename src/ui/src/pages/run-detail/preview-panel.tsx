import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { formatPreviewUrl, previewApi, runsApi } from "@/api/client.ts";
import type { RunRow } from "@/api/types.ts";
import { isActivePreviewState } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Button } from "@/components/ui/button.tsx";
import { StatusBadge, stateLabel } from "@/components/ui/status.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { formatError } from "@/lib/format-error.ts";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";
import { formatPreviewStateLabel } from "@/pages/run-detail/preview-labels.ts";
import { Fact, FactCard } from "./side-panels.tsx";

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
				<Fact label="URL" mono>
					<span className="break-all text-(--color-primary)">{canonicalUrl}</span>
				</Fact>
			) : null}
			{run.previewPort !== null ? (
				<Fact label="Port">
					<span className="tabular-nums">{run.previewPort}</span>
					{mode !== undefined ? ` · ${mode} mode` : ""}
				</Fact>
			) : null}
			{run.previewStartedAt !== null ? (
				<Fact label="Started">{formatTimestamp(run.previewStartedAt)}</Fact>
			) : null}
			{run.previewLastHitAt !== null ? (
				<Fact label="Last visit">{relativeTime(run.previewLastHitAt)}</Fact>
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
		<FactCard
			title="Preview"
			actions={<StatusBadge state={state} label={formatPreviewStateLabel(state)} />}
		>
			<PreviewFacts run={run} canonicalUrl={canonicalUrl} mode={mode} />
			{state === "failed" && run.previewFailureMessage ? (
				<pre
					className="mt-2 max-h-40 overflow-auto rounded-sm border border-(--color-border) bg-(--color-bg) p-2 font-mono text-2xs break-words whitespace-pre-wrap text-(--color-danger)"
					title="Sidecar output or readiness-probe failure"
				>
					{run.previewFailureMessage}
				</pre>
			) : null}
			<OperatorOnly>
				{state === "live" || isActive ? (
					<div className="mt-2 flex flex-wrap items-start gap-2">
						{state === "live" ? <PreviewLoginButton runId={run.id} /> : null}
						{isActive ? <PreviewTeardownButton runId={run.id} mode={mode} /> : null}
					</div>
				) : null}
			</OperatorOnly>
		</FactCard>
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
			<Button
				variant="outline"
				size="sm"
				onClick={openPreview}
				disabled={login.isPending}
				title="Sign a preview session cookie and open the live preview"
			>
				<ExternalLink aria-hidden />
				{login.isPending ? "Opening…" : "Open preview"}
			</Button>
			{login.isError ? (
				<p className="text-xs text-(--color-danger)">Could not open: {formatError(login.error)}</p>
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
			<Button
				variant="outline"
				size="sm"
				onClick={() => teardown.mutate()}
				disabled={teardown.isPending}
				title={title}
				className="text-(--color-danger)"
			>
				{teardown.isPending ? "Tearing down…" : "Tear down"}
			</Button>
			{teardown.isError ? (
				<p className="text-xs text-(--color-danger)">
					Could not tear down: {formatError(teardown.error)}
				</p>
			) : null}
			{teardown.isSuccess && teardown.data !== undefined ? (
				<p className="text-xs text-(--color-text-2)">{stateLabel(teardown.data.status)}</p>
			) : null}
		</div>
	);
}
