import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { metaApi, setApiToken, UnauthorizedError } from "@/api/client.ts";
import { useCapabilities } from "@/hooks/use-capabilities.ts";

/**
 * The Direction C token gate (warren-9297 / pl-7e38 step 19), translated
 * from the Paper export `docs/ui-revamp/screens/login.jsx`: one centered
 * 360px card on the bare background, the hexagon mark, a mono input, and
 * a spectator entry row that only appears when the instance allows it.
 *
 * The auth flow is unchanged from the legacy page (warren-f53e): the
 * token is probed against `/whoami`, a non-operator acceptance is
 * rejected, the query cache is cleared so post-login reads are full, and
 * `/login` stays mounted outside the shell so it never renders operator
 * affordances. Only the surface changed.
 */

/** Card width from the artboard. */
const CARD_WIDTH = 360;

/** The hexagon workload mark from the export, drawn in the token ink. */
function LoginMark() {
	return (
		<svg
			viewBox="0 0 100 100"
			role="img"
			aria-label="Warren"
			className="h-7 w-7 shrink-0"
			style={{ color: "var(--color-text-2)" }}
		>
			<polygon
				points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34"
				fill="none"
				stroke="currentColor"
				strokeWidth="2.2"
				style={{ opacity: 0.35 }}
			/>
			<g style={{ opacity: 0.55 }}>
				<line x1="50" y1="50" x2="50" y2="18" stroke="currentColor" strokeWidth="2.2" />
				<line x1="50" y1="50" x2="77.7" y2="66" stroke="currentColor" strokeWidth="2.2" />
				<line x1="50" y1="50" x2="50" y2="82" stroke="currentColor" strokeWidth="2.2" />
				<line x1="50" y1="50" x2="22.3" y2="66" stroke="currentColor" strokeWidth="2.2" />
				<line x1="50" y1="50" x2="22.3" y2="34" stroke="currentColor" strokeWidth="2.2" />
			</g>
			<line x1="50" y1="50" x2="77.7" y2="34" stroke="currentColor" strokeWidth="2.2" />
			<g style={{ opacity: 0.55 }}>
				<circle cx="50" cy="18" r="4.5" fill="currentColor" />
				<circle cx="77.7" cy="66" r="4.5" fill="currentColor" />
				<circle cx="50" cy="82" r="4.5" fill="currentColor" />
				<circle cx="22.3" cy="66" r="4.5" fill="currentColor" />
				<circle cx="22.3" cy="34" r="4.5" fill="currentColor" />
			</g>
			<circle cx="77.7" cy="34" r="4.5" fill="currentColor" />
			<rect
				x="42"
				y="42"
				width="16"
				height="16"
				rx="2.8"
				fill="currentColor"
				style={{ opacity: 0.85 }}
			/>
		</svg>
	);
}

/** Boot facts the gate renders: runtime + auth mode line and the version strip. */
function useInstanceFacts() {
	return useQuery({
		queryKey: ["meta", "instance"],
		queryFn: ({ signal }) => metaApi.instance(signal),
		staleTime: 60_000,
		retry: 1,
	});
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
	// page has no sidebar and no topbar. A browser warren already admitted
	// can return to the console; otherwise spectator entry exists only when
	// the instance's boot-resolved auth mode is `public` (from `/instance`,
	// never inferred — a stale token must not conjure the row).
	const admitted = caps.status === "ready";
	const spectatorAllowed = facts.data?.authMode === "public";

	const onSubmit = async (e: React.FormEvent): Promise<void> => {
		e.preventDefault();
		if (token.length === 0) {
			setError("Token cannot be empty");
			return;
		}
		setPending(true);
		setError(null);
		setApiToken(token);
		try {
			// Probe `/whoami` to validate the bearer (warren-f53e). It 401s a
			// bad token under both `WARREN_AUTH` kinds — unlike `/agents`,
			// which returns 200 to a credential-less caller on a public
			// instance and so can't tell "valid token" from "admitted as a
			// spectator".
			const who = await metaApi.whoami();
			if (who.identity !== "operator") {
				setApiToken(null);
				setError("Token was accepted but grants no operator capabilities.");
				return;
			}
			// Anything cached pre-login was fetched anonymously and carries
			// the public projection; drop it so post-login reads are full.
			qc.clear();
			navigate("/operations", { replace: true });
		} catch (err) {
			setApiToken(null);
			if (err instanceof UnauthorizedError) {
				setError("Token rejected by server.");
			} else {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			setPending(false);
		}
	};

	const instanceLine =
		facts.data === undefined ? null : `${facts.data.runtime} · ${facts.data.authMode} auth`;
	const footerLine =
		facts.data === undefined
			? "WARREN"
			: `WARREN v${facts.data.version} · ${facts.data.authMode === "public" ? "PUBLIC" : "TOKEN"} AUTH`;

	return (
		<div className="flex min-h-dvh flex-col items-center justify-center overflow-clip bg-(--color-bg) p-6">
			<div
				className="flex flex-col rounded-[var(--radius-md)] border border-(--color-border) bg-(--color-surface) text-(--color-text)"
				style={{ width: CARD_WIDTH }}
			>
				{/* Mark + wordmark + instance line. */}
				<div className="flex flex-col items-center gap-2.5 px-7 pt-8 pb-5">
					<LoginMark />
					<div className="text-[16px] leading-5 font-semibold tracking-[-0.025em]">warren</div>
					{instanceLine !== null ? (
						<div className="font-mono text-[10px] leading-3 text-(--color-text-3)">
							{instanceLine}
						</div>
					) : null}
				</div>

				{/* Token form. */}
				<form onSubmit={onSubmit} className="flex flex-col gap-3.5 px-7 pt-2 pb-6">
					<div className="flex flex-col gap-1.5">
						<label
							htmlFor="token"
							className="text-[9px] leading-3 font-semibold tracking-[0.05em] text-(--color-text-3)"
						>
							API TOKEN
						</label>
						<input
							id="token"
							name="token"
							type="password"
							autoComplete="off"
							value={token}
							onChange={(e) => {
								setToken(e.target.value);
							}}
							placeholder="wrn_…"
							className="h-[34px] rounded-[var(--radius-sm)] border border-(--color-border-strong) bg-(--color-bg) px-2.5 font-mono text-[11px] leading-[14px] text-(--color-text-2) outline-none placeholder:text-(--color-text-3) focus:border-(--color-primary)"
						/>
						<p className="text-[10px] leading-[14px] text-(--color-text-3)">
							Verified against <code>/whoami</code>. Stored in this browser only.
						</p>
					</div>
					{error !== null ? (
						<p role="alert" className="text-[10px] leading-[14px] text-(--color-danger)">
							{error}
						</p>
					) : null}
					<button
						type="submit"
						disabled={pending}
						className="h-[34px] shrink-0 rounded-[var(--radius-sm)] bg-(--color-primary) text-[11px] leading-[14px] font-medium text-(--color-primary-ink) disabled:opacity-60"
					>
						{pending ? "Verifying…" : "Sign in"}
					</button>
				</form>

				{/* Spectator entry — only when the instance allows it. */}
				{admitted || spectatorAllowed ? (
					<div className="flex h-11 shrink-0 items-center justify-center gap-1.5 border-t border-(--color-border)">
						{admitted ? (
							<>
								<span className="text-[10px] leading-3 text-(--color-text-3)">
									Already signed in —
								</span>
								<Link
									to="/operations"
									className="text-[10px] leading-3 font-medium text-(--color-primary) hover:underline"
								>
									return to the console →
								</Link>
							</>
						) : (
							<>
								<span className="text-[10px] leading-3 text-(--color-text-3)">
									This instance allows read-only spectators —
								</span>
								<Link
									to="/operations"
									className="text-[10px] leading-3 font-medium text-(--color-primary) hover:underline"
								>
									continue without a token →
								</Link>
							</>
						)}
					</div>
				) : null}
			</div>

			{/* Version / auth strip under the card (mono 9px, artboard copy). */}
			<div className="pt-[18px]">
				<span className="font-mono text-[9px] leading-3 tracking-[0.05em] text-(--color-text-3)">
					{footerLine} · A STALE TOKEN RETURNS 401, NEVER THE PUBLIC VIEW
				</span>
			</div>
		</div>
	);
}
