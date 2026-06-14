import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { conversationsApi, runsApi } from "@/api/client.ts";
import { RUN_TERMINAL_STATES } from "@/api/types.ts";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { formatError } from "@/lib/format-error.ts";
import { ConversationSplitView } from "./conversation-detail/conversation-surface.tsx";
import { DispatchPlanButton } from "./conversation-detail/dispatch-plan-dialog.tsx";
import { RewakeButton } from "./conversation-detail/rewake-button.tsx";

/**
 * /leveret/:id — the Leveret conversation split-view (warren-01c8,
 * build-phase 4).
 *
 * The split-view body (streamed chat + dynamic intent editor + send-off)
 * lives in the shared `ConversationSplitView` (pl-0008 step 7 / warren-3de4)
 * so this page and the Workspace Shape tab render an identical surface. This
 * page wraps it in a Leveret-flavoured PageHeader carrying the conversation
 * title, the Re-wake control, and the operator-gated 'Dispatch plan' popup
 * (warren-6e45) that appears once the merge poller has dispatched the planner.
 */
export function ConversationDetailPage(): JSX.Element {
	const { id = "" } = useParams<{ id: string }>();

	const conversation = useQuery({
		queryKey: ["conversation", id],
		queryFn: ({ signal }) => conversationsApi.get(id, signal),
		refetchInterval: 5000,
		enabled: id.length > 0,
	});

	const row = conversation.data?.conversation;

	const anchoringRunId = row?.anchoringRunId;
	const anchoringRun = useQuery({
		queryKey: ["run", anchoringRunId],
		queryFn: ({ signal }) => runsApi.get(anchoringRunId ?? "", signal),
		enabled: anchoringRunId !== null && anchoringRunId !== undefined && anchoringRunId !== "",
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data) return 5000;
			return RUN_TERMINAL_STATES.includes(data.state) ? false : 3000;
		},
	});

	const isAnchoringRunTerminal =
		anchoringRun.data !== undefined && RUN_TERMINAL_STATES.includes(anchoringRun.data.state);

	return (
		<div className="space-y-6">
			<PageHeader
				title={row?.title || "Conversation"}
				description={
					<span className="font-mono text-xs text-(--color-muted-foreground)">{id}</span>
				}
				actions={
					<div className="flex items-center gap-2">
						{row !== undefined ? (
							<RewakeButton
								conversation={row}
								isAnchoringRunTerminal={isAnchoringRunTerminal}
							/>
						) : null}
						{row?.plannerRunId != null && row.plannerRunId !== "" && row.projectId !== null ? (
							<DispatchPlanButton
								projectId={row.projectId}
								plotId={row.plotId}
								plannerRunId={row.plannerRunId}
							/>
						) : null}
						<Link to="/leveret" className="text-sm underline-offset-2 hover:underline">
							← All conversations
						</Link>
					</div>
				}
			/>

			{conversation.isError ? (
				<p className="text-sm text-(--color-destructive)">
					{formatError(conversation.error)}
				</p>
			) : (
				<ConversationSplitView conversationId={id} />
			)}
		</div>
	);
}
