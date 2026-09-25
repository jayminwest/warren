import { AlertTriangle, Check, Copy, RefreshCw, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";

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
 * error without a full reload. warren-9474 gave the fallback a friendly
 * card with retry, reload, and a copyable error report.
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
	/** React's component stack for the throw, for the copied report. */
	componentStack: string | null;
	copied: boolean;
}

const CLEAR: Pick<State, "error" | "capturedAt" | "componentStack" | "copied"> = {
	error: null,
	capturedAt: null,
	componentStack: null,
	copied: false,
};

/** The plain-text report "Copy error details" puts on the clipboard. */
export function errorReport(error: Error, route: string, componentStack: string | null): string {
	return [
		`${error.name}: ${error.message}`,
		`Route: ${route}`,
		`Time: ${new Date().toISOString()}`,
		error.stack ? `\n${error.stack}` : "",
		componentStack ? `\nComponent stack:${componentStack}` : "",
	]
		.filter((part) => part.length > 0)
		.join("\n");
}

export class ErrorBoundary extends Component<Props, State> {
	override state: State = { ...CLEAR };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error };
	}

	static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
		if (state.error === null) return null;
		if (state.capturedAt === null) return { capturedAt: props.resetKey };
		// Navigated somewhere else — drop the error and try rendering again.
		if (state.capturedAt !== props.resetKey) return { ...CLEAR };
		return null;
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		// Console is the only sink the UI has — warren ships no browser
		// telemetry. Keep the component stack: it names the subtree that
		// threw, which is what turns "blank page" into a one-minute fix.
		console.error("warren UI: unhandled render error", error, info.componentStack);
		this.setState({ componentStack: info.componentStack ?? null });
	}

	private copyDetails = (): void => {
		const { error, componentStack } = this.state;
		if (error === null) return;
		const report = errorReport(error, this.props.resetKey, componentStack);
		navigator.clipboard
			?.writeText(report)
			.then(() => this.setState({ copied: true }))
			.catch(() => undefined);
	};

	override render(): ReactNode {
		const { error, copied } = this.state;
		if (error === null) return this.props.children;
		return (
			<div className="flex justify-center px-3.5 py-10 md:px-6">
				<Card role="alert" className="animate-pop-in w-full max-w-lg">
					<div className="flex flex-col gap-3 p-5">
						<span className="flex size-9 items-center justify-center rounded-full bg-(--color-danger)/12 text-(--color-danger)">
							<AlertTriangle aria-hidden className="size-4.5" />
						</span>
						<h1 className="text-lg font-semibold text-(--color-text)">This page hit a problem</h1>
						<p className="text-sm text-(--color-text-2)">
							Something on this page broke while it was drawing. The rest of warren still works:
							pick another page from the sidebar, or try this one again.
						</p>
						<details className="group rounded-sm border border-(--color-border) bg-(--color-bg)">
							<summary className="cursor-pointer px-3 py-2 text-xs text-(--color-text-3) select-none hover:text-(--color-text-2)">
								Error details
							</summary>
							<pre className="max-h-48 overflow-auto border-t border-(--color-border) px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap text-(--color-text-2)">
								{error.message}
							</pre>
						</details>
					</div>
					<div className="flex flex-col gap-2 border-t border-(--color-border) p-4 sm:flex-row">
						<Button className="h-11 sm:h-8" onClick={() => this.setState({ ...CLEAR })}>
							<RotateCcw />
							Try again
						</Button>
						<Button
							variant="outline"
							className="h-11 sm:h-8"
							onClick={() => window.location.reload()}
						>
							<RefreshCw />
							Reload page
						</Button>
						<Button variant="ghost" className="h-11 sm:ml-auto sm:h-8" onClick={this.copyDetails}>
							{copied ? <Check /> : <Copy />}
							{copied ? "Copied" : "Copy error details"}
						</Button>
					</div>
				</Card>
			</div>
		);
	}
}
