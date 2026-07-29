import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";

/**
 * Route-level error boundary (warren-1f12).
 *
 * Motivation is a concrete production incident, not defensive habit: a
 * wire-shape drift left RunDetail reading a field the server had stopped
 * sending, so a guard treated the absent value as present and a child
 * threw during render. With no boundary mounted, React unmounted the
 * entire root and every `/#/runs/:id` deep link served a blank white page.
 *
 * The stale field is fixed; this makes the *failure mode* survivable. A
 * throw inside the routed page now degrades to one error card with the
 * sidebar and navigation intact, so the next wire-shape drift costs one
 * broken page instead of the whole app.
 *
 * Deliberately a class component — `componentDidCatch` / `getDerivedState`
 * FromError have no hook equivalent. Reset is keyed on `resetKey`
 * (the route pathname) so navigating away from a broken page clears the
 * error without a full reload.
 */
interface Props {
	children: ReactNode;
	/** Changing this value clears a captured error (we pass the pathname). */
	resetKey: string;
}

interface State {
	error: Error | null;
	/** The `resetKey` in force when `error` was captured. */
	capturedAt: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
	override state: State = { error: null, capturedAt: null };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error };
	}

	static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
		if (state.error === null) return null;
		if (state.capturedAt === null) return { capturedAt: props.resetKey };
		// Navigated somewhere else — drop the error and try rendering again.
		if (state.capturedAt !== props.resetKey) return { error: null, capturedAt: null };
		return null;
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		// Console is the only sink the UI has — warren ships no browser
		// telemetry. Keep the component stack: it names the subtree that
		// threw, which is what turns "blank page" into a one-minute fix.
		console.error("warren UI: unhandled render error", error, info.componentStack);
	}

	override render(): ReactNode {
		const { error } = this.state;
		if (error === null) return this.props.children;
		return (
			<div className="space-y-4">
				<Alert variant="danger" title="This page failed to render">
					<p>
						Something in this view threw while rendering. The rest of the app is still usable — pick
						another page from the sidebar, or retry.
					</p>
					<pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-(--color-muted) p-3 font-mono text-xs">
						{error.message}
					</pre>
				</Alert>
				<Button variant="outline" onClick={() => this.setState({ error: null, capturedAt: null })}>
					Retry
				</Button>
			</div>
		);
	}
}
