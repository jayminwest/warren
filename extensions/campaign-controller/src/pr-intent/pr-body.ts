/**
 * The profile-data PR-body renderer (warren-e361, plan pl-096b phase 3).
 *
 * Every section heading, the AI-disclosure paragraph, and the footer are
 * data in the repository-policy profile (`prBodyContract`), never source.
 * This module walks the contract's ordered sections and fills each stable
 * key's content from the checked facts. It declares no heading of its own
 * and no literal section text: the wording lives in `profiles/`.
 */
import { readFileSync } from "node:fs";
import { ValidationError } from "../errors.ts";
import {
	PR_BODY_PLACEHOLDERS,
	type PrBodyContract,
	type PrBodySectionKey,
	validatePrBodyContract,
} from "../repository-policy.ts";

/** The shipped generic contract, used when a profile declares no contract. */
const DEFAULT_CONTRACT_URL = new URL(
	"../../profiles/default.pr-body-contract.json",
	import.meta.url,
);

/** The checked facts the contract templates and section renderers consume. */
export interface PrBodyFacts {
	campaignId: string;
	agent: string;
	provider: string;
	model: string;
	approvedBy: string;
	runId: string;
	branch: string;
	forkOwner: string;
	issueNumber: number;
	problem: string;
	solution: string;
	userImpact: string;
	/** Non-empty validation-evidence lines; rendered as bullets. */
	evidence: readonly string[];
	operatorNotes: string;
}

/** Load the shipped default contract, failing closed on a malformed file. */
export function loadDefaultPrBodyContract(): PrBodyContract {
	const raw: unknown = JSON.parse(readFileSync(DEFAULT_CONTRACT_URL, "utf8"));
	return validatePrBodyContract(raw, "default pr-body contract");
}

/** Fill every `{name}` placeholder from the facts; fail on an unknown token. */
function expandTokens(template: string, facts: PrBodyFacts): string {
	const values: Record<string, string> = {
		campaignId: facts.campaignId,
		agent: facts.agent,
		provider: facts.provider,
		model: facts.model,
		approvedBy: facts.approvedBy,
		runId: facts.runId,
		branch: facts.branch,
		forkOwner: facts.forkOwner,
		issueNumber: String(facts.issueNumber),
	};
	return template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => {
		if (!(PR_BODY_PLACEHOLDERS as readonly string[]).includes(name)) {
			throw new ValidationError(`unknown PR-body placeholder {${name}} — refusing to render`);
		}
		return values[name] ?? whole;
	});
}

/** Each section renderer fills its stable key's content from the facts. */
type SectionRenderer = (facts: PrBodyFacts, disclosure: string) => string[];

const SECTION_RENDERERS: Record<PrBodySectionKey, SectionRenderer> = {
	closes: (facts) => [`Closes #${facts.issueNumber}`],
	disclosure: (_facts, disclosure) => [disclosure],
	problem: (facts) => [facts.problem],
	solution: (facts) => [facts.solution],
	userImpact: (facts) => [facts.userImpact],
	evidence: (facts) => facts.evidence.map((line) => `- ${line}`),
	runReference: (facts) => [
		`- Warren run \`${facts.runId}\` (state: succeeded)`,
		`- Fork branch \`${facts.forkOwner}:${facts.branch}\` — maintainers may push edits to this branch (maintainer_can_modify)`,
		`- Issue: #${facts.issueNumber}`,
	],
	operatorNotes: (facts) => [facts.operatorNotes],
};

/**
 * Render the exact PR body by walking the contract's ordered sections. The
 * footer block (separator + footer template) always closes the body.
 */
export function renderPrBody(contract: PrBodyContract, facts: PrBodyFacts): string {
	const disclosure = expandTokens(contract.disclosureTemplate, facts);
	const blocks: string[][] = [];
	for (const section of contract.sections) {
		const content = SECTION_RENDERERS[section.key](facts, disclosure);
		blocks.push(section.heading === null ? content : [`## ${section.heading}`, "", ...content]);
	}
	blocks.push(["---", "", expandTokens(contract.footerTemplate, facts)]);
	return blocks.map((block) => block.join("\n")).join("\n\n");
}
