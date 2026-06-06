import { useMutation, useQueryClient } from "@tanstack/react-query";
import { conversationsApi } from "@/api/client.ts";
import type { ConversationRow } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { formatError } from "@/lib/format-error.ts";

export interface RewakeButtonProps {
	readonly conversation: ConversationRow;
	readonly isAnchoringRunTerminal: boolean;
}

export function RewakeButton({ conversation, isAnchoringRunTerminal }: RewakeButtonProps): JSX.Element | null {
	const queryClient = useQueryClient();
	const { toast } = useToast();

	const rewakeMutation = useMutation({
		mutationFn: () => conversationsApi.rewake(conversation.id),
		onSuccess: () => {
			toast({
				title: "Conversation re-woken",
				description: "A new anchoring run has been started.",
				variant: "success",
			});
			queryClient.invalidateQueries({ queryKey: ["conversation", conversation.id] });
			queryClient.invalidateQueries({ queryKey: ["conversations"] });
		},
		onError: (err) => {
			toast({
				title: "Failed to re-wake conversation",
				description: formatError(err),
				variant: "danger",
			});
		},
	});

	const isActive = conversation.status === "active";

	if (!isActive || !isAnchoringRunTerminal) {
		return null;
	}

	return (
		<Button
			type="button"
			size="sm"
			variant="outline"
			disabled={rewakeMutation.isPending}
			onClick={() => rewakeMutation.mutate()}
		>
			{rewakeMutation.isPending ? "Re-waking…" : "Re-wake"}
		</Button>
	);
}
