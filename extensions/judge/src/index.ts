/**
 * @warren-ext/judge entrypoint.
 *
 * Resolves and validates the environment contract, then reports readiness.
 * Steps 1–5 of plan pl-17ca landed the wire types, warren read client,
 * verdict store, rubric v1, and the bounded pi-SDK judge loop
 * (`judge-loop.ts` / `pi-session.ts`). The collector daemon that polls for
 * terminal runs and drives judgments is step 6 — see `sd plan show pl-17ca`.
 */
import { ConfigError, resolveConfig } from "./config.ts";

if (import.meta.main) {
	let config;
	try {
		config = resolveConfig(process.env);
	} catch (error) {
		const message = error instanceof ConfigError ? error.message : String(error);
		console.error(`@warren-ext/judge: ${message}`);
		process.exit(1);
	}
	console.log(
		`@warren-ext/judge: config ok (warren=${config.warrenBaseUrl}, ` +
			`judge=${config.provider}/${config.model}) — the judge loop is wired ` +
			"but the collector daemon is not yet implemented (plan pl-17ca step 6); exiting.",
	);
}
