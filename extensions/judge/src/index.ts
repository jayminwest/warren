/**
 * @warren-ext/judge entrypoint.
 *
 * Plan pl-17ca step 1 (warren-6fc4) is scaffold + rubric-v1 wire types only:
 * this module resolves and validates the environment contract, then reports
 * that the judge loop is not yet implemented. Later steps add the warren read
 * client (step 2), the verdict store, and the pi-SDK judge loop. See the
 * build-order note in the plan: `sd plan show pl-17ca`.
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
			`judge=${config.provider}/${config.model}) — the judge loop is not yet ` +
			"implemented (plan pl-17ca step 1); exiting.",
	);
}
