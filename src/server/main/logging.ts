/**
 * pino → narrow logger adapters used by `bootServer` (warren-8d3d /
 * pl-9088 step 10). Each subsystem (bridges, scheduler, plan-run
 * coordinator, pause detector, worker probe, preview-eviction worker)
 * declares its own minimal logger shape so the boot wiring stays
 * decoupled from pino. These adapters are trivial pass-throughs that
 * exist only to satisfy the structural subtype.
 */

import type { Logger } from "../types.ts";

type ObjectLogger = {
	info(obj: object, msg?: string): void;
	warn(obj: object, msg?: string): void;
	error(obj: object, msg?: string): void;
};

type ObjectLoggerWithDebug = ObjectLogger & {
	debug?(obj: object, msg?: string): void;
};

type RecordLogger = {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
};

export function bridgeLoggerFromPino(logger: Logger): Partial<ObjectLogger> {
	return {
		info: (obj, msg) => logger.info(obj, msg),
		warn: (obj, msg) => logger.warn(obj, msg),
		error: (obj, msg) => logger.error(obj, msg),
	};
}

export function probeLoggerFromPino(logger: Logger): ObjectLoggerWithDebug {
	return {
		info: (obj, msg) => logger.info(obj, msg),
		warn: (obj, msg) => logger.warn(obj, msg),
		error: (obj, msg) => logger.error(obj, msg),
		debug: (obj, msg) => logger.debug?.(obj, msg),
	};
}

export function schedulerLoggerFromPino(logger: Logger): RecordLogger {
	return {
		info: (obj, msg) => logger.info(obj, msg),
		warn: (obj, msg) => logger.warn(obj, msg),
		error: (obj, msg) => logger.error(obj, msg),
	};
}

export function planRunLoggerFromPino(logger: Logger): RecordLogger {
	return {
		info: (obj, msg) => logger.info(obj, msg),
		warn: (obj, msg) => logger.warn(obj, msg),
		error: (obj, msg) => logger.error(obj, msg),
	};
}

export function pauseLoggerFromPino(logger: Logger): RecordLogger {
	return {
		info: (obj, msg) => logger.info(obj, msg),
		warn: (obj, msg) => logger.warn(obj, msg),
		error: (obj, msg) => logger.error(obj, msg),
	};
}

export function previewEvictionLoggerFromPino(logger: Logger): RecordLogger {
	return {
		info: (obj, msg) => logger.info(obj, msg),
		warn: (obj, msg) => logger.warn(obj, msg),
		error: (obj, msg) => logger.error(obj, msg),
	};
}
