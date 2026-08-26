/**
 * Process entrypoint: parse argv, run one command, set the exit code.
 * NDJSON on stdout is the machine contract; `--format human` renders text.
 */
import { runCli } from "./run.ts";

const code = await runCli(process.argv.slice(2), { env: process.env });
process.exitCode = code;
