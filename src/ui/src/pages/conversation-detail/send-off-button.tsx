import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { conversationsApi } from "@/api/client.ts";
import type { ConversationRow } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog.tsx";
import { formatError } from "@/lib/format-error.ts";

export function SendOffButton({
	conversation,
	intentNonEmpty,
}: {
	conversation: ConversationRow;
	intentNonEmpty: boolean;
}): JSX.Element {
	const [open, setOpen] = useState(false);
	const queryClient = useQueryClient();

	const sendOffMutation = useMutation({
		mutationFn: () => conversationsApi.sendOff(conversation.id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["conversation", conversation.id] });
			queryClient.invalidateQueries({ queryKey: ["conversations"] });
			setOpen(false);
		},
	});

	const handleSendOff = () => {
		sendOffMutation.mutate();
	};

	if (conversation.status === "closed") {
		return (
			<Button size="sm" disabled>
				Sent to planner
			</Button>
		);
	}

	return (
		<>
			<Button
				size="sm"
				disabled={!intentNonEmpty || sendOffMutation.isPending}
				onClick={() => setOpen(true)}
			>
				Send to planner
			</Button>

			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next) sendOffMutation.reset();
					setOpen(next);
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>Confirm planner send-off</DialogTitle>
						<DialogDescription className="space-y-2 pt-2 text-sm text-(--color-muted-foreground)">
							<p>
								Are you sure you want to send this conversation's intent to the planner?
							</p>
							<p className="font-semibold text-(--color-destructive)">
								Closing the conversation is irreversible — re-plan is a new conversation.
							</p>
						</DialogDescription>
					</DialogHeader>

					{sendOffMutation.isError ? (
						<p className="text-xs text-(--color-destructive) bg-(--color-destructive)/10 p-2 rounded-md">
							{formatError(sendOffMutation.error)}
						</p>
					) : null}

					<DialogFooter>
						<Button
							variant="outline"
							size="sm"
							disabled={sendOffMutation.isPending}
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button
							size="sm"
							disabled={sendOffMutation.isPending}
							onClick={handleSendOff}
						>
							{sendOffMutation.isPending ? "Sending…" : "Confirm send-off"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
