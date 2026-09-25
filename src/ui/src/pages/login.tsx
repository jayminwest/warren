import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { metaApi, setApiToken, UnauthorizedError } from "@/api/client.ts";
import type { InstanceFactsResponse } from "@/api/instance-types.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { WarrenLogo } from "@/components/warren-logo.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { formatError } from "@/lib/format-error.ts";
import { Field, invalidClass } from "./dispatch/field.tsx";

/**
 * The token gate (warren-9297; restyled in warren-9474): one centered card
 * on the bare background with the warren mark, a token field, and — only
 * when it applies — a way back to the console or in as a read-only visitor.
 *
 * The auth flow is unchanged from the legacy page (warren-f53e): the
 * token is probed against `/whoami`, a non-operator acceptance is
 * rejected, the query cache is cleared so post-login reads are full, and
 * `/login` stays mounted outside the shell so it never renders operator
 * affordances. Only the surface changed.
 */

/** Boot facts the gate renders: runtime + version under the title. */
function useInstanceFacts() {
	return useQuery({
		queryKey: ["meta", "instance"],
		queryFn: ({ signal }) => metaApi.instance(signal),
		staleTime: 60_000,
		retry: 1,
	});
}

const RUNTIME_LABEL: Record<InstanceFactsResponse["runtime"], string> = {
	k8s: "Kubernetes",
	docker: "Docker",
	local: "Local",
};

function instanceLine(facts: InstanceFactsResponse | undefined): string {
	if (facts === undefined) return "Paste an API token to continue.";
	return `${RUNTIME_LABEL[facts.runtime]} instance · v${facts.version}`;
}

/** The row under the form: back to the console, or in as a spectator. */
function SecondaryEntry({ admitted, spectator }: { admitted: boolean; spectator: boolean }) {
	if (!admitted && !spectator) return null;
	return (
		<div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 border-t border-(--color-border) px-6 py-3.5 text-center text-xs text-(--color-text-3)">
			<span>{admitted ? "You're already signed in." : "This instance is open to visitors."}</span>
			<Link
				to="/operations"
				className="inline-flex items-center gap-1 font-medium text-(--color-primary) hover:underline"
			>
				{admitted ? "Back to the console" : "Browse read-only"}
				<ArrowRight aria-hidden className="size-3" />
			</Link>
		</div>
	);
}

export function LoginPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const caps = useCapabilities();
	const facts = useInstanceFacts();
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	// `app.tsx` mounts `/login` outside `AuthGate`/`ConsoleShell`, so this
	// page has no sidebar and no topbar. An operator warren already admitted
	// can return to the console; otherwise spectator entry exists only when
	// the instance's boot-resolved auth mode is `public` (from `/instance`,
	// never inferred — a stale token must not conjure the row).
	const admitted = caps.status === "ready" && caps.identity === "operator";
	const spectatorAllowed = facts.data?.authMode === "public";

	const onSubmit = async (e: React.FormEvent): Promise<void> => {
		e.preventDefault();
		const trimmed = token.trim();
		if (trimmed.length === 0) {
			setError("Paste a token first.");
			return;
		}
		setPending(true);
		setError(null);
		setApiToken(trimmed);
		try {
			// Probe `/whoami` to validate the bearer (warren-f53e). It 401s a
			// bad token under both `WARREN_AUTH` kinds — unlike `/agents`,
			// which returns 200 to a credential-less caller on a public
			// instance and so can't tell "valid token" from "admitted as a
			// spectator".
			const who = await metaApi.whoami();
			if (who.identity !== "operator") {
				setApiToken(null);
				setError("That token works, but it can't operate this instance.");
				return;
			}
			// Anything cached pre-login was fetched anonymously and carries
			// the public projection; drop it so post-login reads are full.
			qc.clear();
			navigate("/operations", { replace: true });
		} catch (err) {
			setApiToken(null);
			setError(
				err instanceof UnauthorizedError
					? "Warren didn't accept that token. Check it and try again."
					: `Couldn't reach warren: ${formatError(err)}`,
			);
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-(--color-bg) px-4 py-10">
			<Card className="animate-pop-in w-full max-w-sm self-center">
				<div className="flex flex-col items-center gap-2 px-6 pt-8 pb-5 text-center">
					<WarrenLogo className="size-9 text-(--color-text)" />
					<h1 className="pt-1 text-lg font-semibold text-(--color-text)">Sign in to warren</h1>
					<p className="text-xs text-(--color-text-3)">{instanceLine(facts.data)}</p>
				</div>

				<form onSubmit={onSubmit} className="flex flex-col gap-4 px-6 pb-6">
					<Field
						label="API token"
						htmlFor="token"
						error={error}
						hint="Checked with the server, then kept in this browser only."
					>
						<Input
							id="token"
							name="token"
							type="password"
							autoComplete="off"
							value={token}
							onChange={(e) => setToken(e.target.value)}
							placeholder="wrn_…"
							aria-invalid={error !== null}
							className={`font-mono ${invalidClass(error) ?? ""}`}
						/>
					</Field>
					<Button type="submit" size="lg" className="h-11 w-full sm:h-9" disabled={pending}>
						{pending ? "Checking…" : "Sign in"}
					</Button>
				</form>

				<SecondaryEntry admitted={admitted} spectator={!admitted && spectatorAllowed} />
			</Card>

			<p className="max-w-sm text-center text-xs text-(--color-text-3)">
				Tokens come from whoever runs this warren instance.
			</p>
		</div>
	);
}
