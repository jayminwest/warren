import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { metaApi, setApiToken, UnauthorizedError } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

export function LoginPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

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
			// bad token under both `WARREN_AUTH` kinds and answers with the
			// caller's identity on success — unlike `/agents`, which returns
			// 200 to a credential-less caller on a public instance and so
			// can't tell "valid token" from "admitted as a spectator".
			const who = await metaApi.whoami();
			if (who.identity !== "operator") {
				setApiToken(null);
				setError("Token was accepted but grants no operator capabilities.");
				return;
			}
			// Anything cached pre-login was fetched anonymously and carries
			// the public projection; drop it so post-login reads are full.
			qc.clear();
			navigate("/runs", { replace: true });
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

	return (
		<div className="flex min-h-screen items-center justify-center p-6">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>warren</CardTitle>
					<CardDescription>
						Paste your <code>WARREN_API_TOKEN</code> to access the control plane.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={onSubmit} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="token">API token</Label>
							<Input
								id="token"
								type="password"
								autoComplete="off"
								value={token}
								onChange={(e) => setToken(e.target.value)}
								placeholder="warren-…"
								autoFocus
							/>
						</div>
						{error !== null ? (
							<p className="text-sm text-(--color-destructive)">{error}</p>
						) : null}
						<Button type="submit" disabled={pending} className="w-full">
							{pending ? "Verifying…" : "Continue"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
