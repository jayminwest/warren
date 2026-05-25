import { WarrenError } from "../core/errors.ts";

export class WarrenUnreachableError extends WarrenError {
	readonly code = "warren_unreachable";
}

export class WarrenClientError extends WarrenError {
	readonly status: number;
	readonly code: string;
	readonly hint?: string;

	constructor(status: number, code: string, message: string, hint?: string) {
		super(message, hint !== undefined ? { recoveryHint: hint } : undefined);
		this.name = "WarrenClientError";
		this.status = status;
		this.code = code;
		this.hint = hint;
	}
}
