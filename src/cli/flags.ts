/**
 * Commander boundary helpers shared by the program definition in
 * `main.ts`: custom flag argParsers and the parse-rejection → exit-code
 * mapping. Split out of `main.ts` to keep it under the `check:size`
 * budget.
 */

import { CommanderError, InvalidArgumentError } from "commander";
import { coerceCostCap } from "../runs/cost-cap.ts";
import { EXIT_USAGE } from "./output.ts";

/**
 * Map a rejection from `program.parseAsync` to the warren-b61e exit
 * table. Every non-zero CommanderError is a usage error — bad flags,
 * missing required options, unknown commands, invalid argParser values
 * (e.g. `--max-cost-usd abc`) — and the table promises exit 2 for all
 * of them, while commander's own default exitCode is 1. Zero passes
 * through (`--help` / `--version`). Non-commander rejections keep the
 * generic failure exit 1.
 */
export function resolveCliExitCode(err: unknown): number {
	if (err instanceof CommanderError) {
		return err.exitCode === 0 ? 0 : EXIT_USAGE;
	}
	return 1;
}

/**
 * Commander argParser for `--max-cost-usd`. Delegates validity to the
 * canonical warren-a63d cap reader (`coerceCostCap`) so the flag boundary
 * and the bridge's enforcement can never disagree about what a valid cap
 * is; a value the reader maps to "no cap" fails the command loudly here
 * instead of coercing downstream into an uncapped run.
 */
export function parseMaxCostUsd(value: string): number {
	const parsed = coerceCostCap(value);
	if (parsed === null) {
		throw new InvalidArgumentError("must be a positive number of USD");
	}
	return parsed;
}
