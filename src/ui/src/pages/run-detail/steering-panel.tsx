import { useMutation } from "@tanstack/react-query";
import { Send, Square } from "lucide-react";
import { useState } from "react";
import { runsApi } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardBody, CardHeader } from "@/components/ui/card.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { formatError } from "@/lib/format-error.ts";

/**
 * The steering composer and the cancel-run header action (warren-8c85,
 * migrated in warren-9474). Both mutate, so both mount only inside
 * OperatorOnly — the spectator projection never renders them.
 */

export function SteerForm({ runId, disabled }: { runId: string; disabled: boolean }) {
	const [body, setBody] = useState("");
	const [sent, setSent] = useState(false);

	const steer = useMutation({
		mutationFn: () => runsApi.steer(runId, { body }),
		onSuccess: () => {
			setBody("");
			setSent(true);
			window.setTimeout(() => setSent(false), 3000);
		},
	});
	const empty = body.trim().length === 0;

	return (
		<Card className="self-stretch">
			<CardHeader title="Steer the agent" meta="Delivered at its next turn" />
			<CardBody>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (!empty) steer.mutate();
					}}
					className="flex flex-col gap-2"
				>
					<Textarea
						rows={3}
						value={body}
						onChange={(e) => setBody(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !empty) steer.mutate();
						}}
						disabled={disabled}
						placeholder={disabled ? "This run has ended." : "Tell the agent what to change…"}
						className="resize-y"
					/>
					<div className="flex items-center justify-between gap-2">
						<p
							aria-live="polite"
							className={
								steer.isError ? "text-xs text-(--color-danger)" : "text-xs text-(--color-text-3)"
							}
						>
							{steer.isError
								? `Could not send: ${formatError(steer.error)}`
								: sent
									? "Sent. The agent reads it at its next turn."
									: "⌘ Enter to send"}
						</p>
						<Button type="submit" size="sm" disabled={disabled || steer.isPending || empty}>
							<Send aria-hidden />
							{steer.isPending ? "Sending…" : "Send"}
						</Button>
					</div>
				</form>
			</CardBody>
		</Card>
	);
}

export function CancelRunButton({ runId, onSettled }: { runId: string; onSettled: () => void }) {
	const cancel = useMutation({
		mutationFn: () => runsApi.cancel(runId, {}),
		onSettled,
	});
	return (
		<div className="flex flex-col items-end gap-1">
			<Button
				variant="outline"
				onClick={() => cancel.mutate()}
				disabled={cancel.isPending}
				className="text-(--color-danger)"
			>
				<Square aria-hidden className="fill-current" />
				{cancel.isPending ? "Cancelling…" : "Cancel run"}
			</Button>
			{cancel.isError ? (
				<p className="text-xs text-(--color-danger)">
					Could not cancel: {formatError(cancel.error)}
				</p>
			) : null}
			{cancel.isSuccess && cancel.data !== undefined ? (
				<p className="text-xs text-(--color-text-2)">
					{cancel.data.alreadyTerminal
						? "The run had already ended."
						: "Cancel sent. The run stops shortly."}
				</p>
			) : null}
		</div>
	);
}
