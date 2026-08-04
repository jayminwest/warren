import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Trash2 } from "lucide-react";
import { formatPreviewUrl, previewApi, runsApi } from "@/api/client.ts";
import type { PreviewState, PreviewTeardownResponse, RunRow } from "@/api/types.ts";
import { isActivePreviewState } from "@/api/types.ts";
import { OperatorOnly } from "@/components/OperatorOnly.tsx";
import { StatusIndicator } from "@/components/StatusIndicator.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { formatError } from "@/lib/format-error.ts";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";

/**
 * Per-run preview environment surface (R-19 / docs/design/preview-environments.md, warren-c0b9).
 * Renders one of four states populated by reap's `preview_launch` sub-
 * step + the eviction / teardown paths:
 *
 *   - `starting`  — readiness probe pending; teardown is allowed (lets
 *                    the operator abort a hung sidecar).
 *   - `live`      — proxy can route; surface an "Open ↗" button that
 *                    runs the bearer-gated login handshake (signs a
 *                    `warren_preview` cookie, answers with the
 *                    mode-correct target) and a teardown button. The
 *                    canonical URL is rendered as a copyable string so
 *                    operators can share it.
 *   - `failed`    — `previewFailureMessage` holds the stderr tail; no
 *                    URL, no teardown (already released).
 *   - `torn-down` — informational only; the port was released and the
 *                    sidecar killed. Workspace stays for repush.
 *
 * URL shape honors `WARREN_PREVIEW_MODE` (warren-016d) — path mode shows
 * `<origin>/p/<id>/`, subdomain mode shows `https://run-<id>.<host>/`.
 * Both reflect where the login handshake actually redirects.
 *
 * Visible only when the run row has a non-null `previewState` — the
 * caller guards on that.
 */
export function PreviewCard({ run }: { run: RunRow }) {
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
		// (warren-f53e). Without it the card drops the canonical URL and
		// mode badge, which are the operator's affordances anyway.
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
		<Card>
			<CardHeader className="flex-row items-center justify-between space-y-0">
				<CardTitle className="flex items-center gap-2">
					Preview
					<PreviewStateBadge state={state} />
					{mode !== undefined ? (
						<Badge
							variant="secondary"
							className="font-mono text-xs"
							title={
								mode === "path"
									? "Path-mode previews ride on the warren hostname under /p/<run-id>/, on their own preview port"
									: "Subdomain-mode previews ride on run-<id>.<host>"
							}
						>
							{mode}
						</Badge>
					) : null}
				</CardTitle>
				{state === "live" ? (
					<OperatorOnly>
						<PreviewOpenButton runId={run.id} />
					</OperatorOnly>
				) : null}
			</CardHeader>
			<CardContent className="space-y-3">
				{canonicalUrl !== null ? <PreviewMetaLine label="URL" value={canonicalUrl} mono /> : null}
				<div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
					{run.previewPort !== null ? (
						<PreviewMetaLine label="Port" value={String(run.previewPort)} />
					) : null}
					{run.previewStartedAt !== null ? (
						<PreviewMetaLine label="Started" value={formatTimestamp(run.previewStartedAt)} />
					) : null}
					{run.previewLastHitAt !== null ? (
						<PreviewMetaLine label="Last hit" value={relativeTime(run.previewLastHitAt)} />
					) : null}
				</div>
				{state === "failed" && run.previewFailureMessage ? (
					<pre
						className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-(--color-muted) p-2 font-mono text-xs text-(--color-destructive)"
						title="Sidecar stderr / readiness-probe failure tail"
					>
						{run.previewFailureMessage}
					</pre>
				) : null}
				{isActive ? (
					<OperatorOnly>
						<PreviewTeardownButton runId={run.id} mode={mode} />
					</OperatorOnly>
				) : null}
			</CardContent>
		</Card>
	);
}

function PreviewMetaLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<div className="flex items-baseline gap-2">
			<span className="uppercase tracking-wide text-(--color-muted-foreground)">{label}</span>
			<span className={mono === true ? "font-mono break-all" : "font-mono"}>{value}</span>
		</div>
	);
}

/**
 * "Open ↗" affordance for a live preview (warren-e1b0).
 *
 * This used to be an `<a href="/runs/:id/preview/login?token=…">`, which
 * put the warren bearer in a URL — and therefore in browser history, in
 * the `Referer` header of every preview sub-resource, and in any proxy
 * or analytics log on the path. It is a button now: the click POSTs the
 * bearer-gated handshake (credential in the `Authorization` header), the
 * browser stores the `Set-Cookie` that response carries, and only then
 * do we navigate to the mode-correct URL the server returned.
 *
 * The tab is opened *synchronously* inside the click handler and pointed
 * at the target once the handshake resolves — a `window.open` issued
 * from an async continuation is rejected by popup blockers. `opener` is
 * nulled so the preview (untrusted, agent-authored code) can't reach
 * back into the warren UI window; when the popup is blocked outright we
 * fall back to navigating the current tab.
 */
function PreviewOpenButton({ runId }: { runId: string }) {
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
		<div className="flex flex-col items-end gap-1">
			<Button
				variant="outline"
				size="sm"
				onClick={openPreview}
				disabled={login.isPending}
				title="Sign a preview session cookie and open the live preview"
			>
				{login.isPending ? "Opening…" : "Open"}
				<ExternalLink className="h-3.5 w-3.5" />
			</Button>
			{login.isError ? (
				<p className="text-xs text-(--color-destructive)">{formatError(login.error)}</p>
			) : null}
		</div>
	);
}

function PreviewStateBadge({ state }: { state: PreviewState }) {
	// warren-3849: delegate to the unified StatusIndicator registry so
	// preview state colour/icon/pulse stays in lockstep with run state.
	return <StatusIndicator kind="preview" status={state} />;
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
				variant="destructive"
				size="sm"
				onClick={() => teardown.mutate()}
				disabled={teardown.isPending}
				title={title}
			>
				<Trash2 className="h-4 w-4" />
				{teardown.isPending ? "Tearing down…" : "Tear down"}
			</Button>
			<PreviewTeardownStatusLine mutation={teardown} />
		</div>
	);
}

function PreviewTeardownStatusLine({
	mutation,
}: {
	mutation: ReturnType<typeof useMutation<PreviewTeardownResponse, Error, void>>;
}) {
	if (mutation.isError) {
		return (
			<p className="text-xs text-(--color-destructive)">
				{mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
			</p>
		);
	}
	if (mutation.isSuccess && mutation.data !== undefined) {
		const d = mutation.data;
		const tone = d.tornDown
			? "text-emerald-700 dark:text-emerald-300"
			: "text-(--color-muted-foreground)";
		return <p className={`text-xs ${tone}`}>{d.status}</p>;
	}
	return null;
}
