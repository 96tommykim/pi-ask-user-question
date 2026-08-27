/**
 * external-action gate — pure logic
 *
 * Rules for the `tool_call` runtime gate in index.ts: which bash commands are
 * external or destructive enough to require just-in-time user approval.
 *
 * Ported from the retired dotfiles extension `confirm-external-writes.ts`, and
 * kept in sync with the sibling ports for the other harnesses:
 *   - Claude Code: native/claude/hooks/confirm-external-writes.sh (PreToolUse)
 *   - Codex:       native/codex/rules/confirm-external-writes.rules (execpolicy)
 *
 * No imports from Pi packages or typebox, so this runs under plain
 * `node --test` without the host runtime installed.
 */

import { hasTerminalControl, type Question } from "./ask.ts";

export const CANCEL_LABEL = "Cancel";
export const APPROVE_LABEL = "Approve once";
export const APPROVAL_HEADER = "Approve?";

/** Longest command rendered into the dialog before it is elided. */
export const MAX_COMMAND_LENGTH = 1000;

/**
 * Control characters and whitespace, as one run. Built from a string so the
 * source file itself stays free of the literal control characters it matches.
 */
const CONTROL_OR_WHITESPACE_RUN = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\s]+", "g");

export interface ExternalActionRule {
	re: RegExp;
	reason: string;
}

/**
 * Unlike the Codex `prefix_rule` port, these can inspect flags, so `gh api`
 * matches a mutating request rather than every invocation.
 */
export const EXTERNAL_ACTION_RULES: ExternalActionRule[] = [
	{ re: /(^|[\s;&|(])git\s+push(\s|$)/, reason: "git push — pushes to a remote repository." },
	{ re: /gh\s+pr\s+(create|merge|edit|ready|close|reopen|comment)/, reason: "gh pr — creates or modifies a pull request." },
	{ re: /gh\s+issue\s+(create|edit|close|reopen|comment|delete)/, reason: "gh issue — creates or modifies an issue." },
	{ re: /gh\s+release\s+(create|edit|delete|upload)/, reason: "gh release — creates or modifies a release." },
	// Mutating gh api: explicit -X/--method (space/=/quoted forms), or body
	// fields (-f/-F/--field/--raw-field/--input, adjoined -fkey=value included)
	// which default the method to POST. No \b after -f/-F: pflag accepts the
	// value glued to the shorthand.
	{
		re: /gh\s+api\b.*((-X|--method)[=\s]*["']?(POST|PUT|PATCH|DELETE)\b|\s(-f|-F|--field|--raw-field|--input))/,
		reason: "gh api — sends a mutating request (POST/PUT/PATCH/DELETE or body fields).",
	},
	{ re: /(^|[\s;&|(])rm\s+-[a-z]*r[a-z]*f?\b/, reason: "rm -rf — recursive deletion." },
	{ re: /(^|[\s;&|(])sudo\b/, reason: "sudo — escalates privileges." },
];

/** The first matching rule, or undefined when the command needs no approval. */
export function matchExternalAction(command: string): ExternalActionRule | undefined {
	return EXTERNAL_ACTION_RULES.find((rule) => rule.re.test(command));
}

/**
 * Make a model-supplied command safe to render as dialog text. Every question
 * field rejects terminal control characters, and that includes the newlines a
 * heredoc or a `\`-continued command carries, so collapse control and
 * whitespace runs to single spaces and elide anything past MAX_COMMAND_LENGTH.
 */
export function sanitizeCommand(command: string): string {
	const flattened = command.replace(CONTROL_OR_WHITESPACE_RUN, " ").trim();
	if (flattened.length <= MAX_COMMAND_LENGTH) return flattened;
	return `${flattened.slice(0, MAX_COMMAND_LENGTH - 1)}…`;
}

/**
 * The approval question, safe-first: Cancel is the option the cursor starts on,
 * so a stray enter blocks rather than approves.
 */
export function buildApprovalQuestion(rule: ExternalActionRule, command: string): Question {
	const shown = sanitizeCommand(command);
	const question = `${rule.reason} Approve this exact command?  $ ${shown || "(empty command)"}`;
	if (hasTerminalControl(question)) {
		throw new Error("Sanitized approval question still contains terminal control characters.");
	}
	return {
		question,
		header: APPROVAL_HEADER,
		options: [
			{ label: CANCEL_LABEL, description: "Block it and tell the agent it was not approved." },
			{ label: APPROVE_LABEL, description: "Run this exact command once, now." },
		],
	};
}
