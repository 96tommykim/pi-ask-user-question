/**
 * ask_user_question — Pi extension entry
 *
 * Registers two independent things that share one dialog:
 *
 *   1. an `ask_user_question` tool, schema-compatible with Claude Code's
 *      AskUserQuestion, for decisions that are genuinely the user's to make;
 *   2. a `tool_call` runtime gate that blocks external or destructive shell
 *      commands until the user approves them (gate.ts).
 *
 * The gate is enforced by the host, not by the model: nothing has to be
 * remembered, asked, or deferred to a later assistant turn for it to hold.
 *
 * In the TUI every question shares one tabbed custom dialog (dialog.ts);
 * non-TUI dialog-capable sessions (RPC) fall back to Pi's built-in
 * `ctx.ui.select`/`ctx.ui.input` dialogs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	assertInteractiveQuestionSession,
	formatAnswers,
	formatOption,
	joinMultiSelectAnswer,
	multiSelectItems,
	validatedQuestionsOrThrow,
	singleSelectItems,
	titleFor,
	toggleIndexForItem,
} from "./ask.ts";
import { promptQuestions } from "./dialog.ts";
import { APPROVE_LABEL, buildApprovalQuestion, type ExternalActionRule, matchExternalAction } from "./gate.ts";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short label for this option, shown as the primary choice text." }),
	description: Type.String({ description: "One-line explanation of what choosing this option means." }),
});

const QuestionSchema = Type.Object({
	question: Type.String({ description: "The question to ask the user." }),
	header: Type.String({
		description: "Short chip label for this question, about 12 characters or fewer, e.g. 'Auth method'.",
	}),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 4,
		description: "2-4 mutually exclusive options for the user to choose from.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set true when the choices are not mutually exclusive and more than one may be picked." }),
	),
});

const AskUserQuestionParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 4,
		description: "1-4 questions to ask the user, presented one at a time.",
	}),
});

const DESCRIPTION =
	"Ask the user one or more structured multiple-choice questions when you are blocked on a decision that is genuinely the user's to make — not one you could resolve yourself with more research or a reasonable default. Ask 1 to 4 questions per call, each with 2 to 4 mutually exclusive options that have a short label and a one-line description. Set 'header' to a short chip label (about 12 characters or fewer) that summarizes the question's topic, e.g. 'Auth method'. Set multiSelect to true only when a question's choices are not mutually exclusive and the user may pick more than one of them. The user can always answer with free text through a built-in 'Other' entry, so do not add your own 'Other' option to the options list. Keep dialog text concise; put long context in normal assistant text. Do not use this tool for choices that have an obvious conventional default or that you could reasonably decide yourself.";

/**
 * Ask for approval through the same dialog the tool uses. Returns false on any
 * dismissal so every non-approval path blocks.
 */
async function confirmExternalAction(ctx: ExtensionContext, rule: ExternalActionRule, command: string): Promise<boolean> {
	const question = buildApprovalQuestion(rule, command);

	if (ctx.mode === "tui") {
		const pairs = await promptQuestions(ctx, [question], ctx.signal);
		return pairs?.[0]?.answer === APPROVE_LABEL;
	}

	// RPC fallback: no custom components, so use the built-in select. Two options
	// only, and no "Other" entry — a free-text answer is not an approval.
	const items = question.options.map(formatOption);
	const approveItem = items[question.options.findIndex((o) => o.label === APPROVE_LABEL)];
	const choice = await ctx.ui.select(question.question, items, { signal: ctx.signal });
	// Both undefined must not read as a match: a dismissed select returns undefined.
	return approveItem !== undefined && choice === approveItem;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description: DESCRIPTION,
		parameters: AskUserQuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const rawQuestions = typeof params === "object" && params !== null ? (params as { questions?: unknown }).questions : undefined;
			const questions = validatedQuestionsOrThrow(rawQuestions);

			assertInteractiveQuestionSession(ctx.hasUI, process.env.PI_SUBAGENT_CHILD === "1");

			if (ctx.mode === "tui") {
				// One unified tabbed dialog for the whole call, with back/forward
				// navigation between questions — see dialog.ts.
				const pairs = await promptQuestions(ctx, questions, signal);
				if (pairs === undefined) {
					throw new Error("User dismissed the question");
				}
				return { content: [{ type: "text", text: formatAnswers(pairs) }], details: undefined };
			}

			// RPC fallback: no custom components outside the TUI, so ask each question
			// sequentially with the built-in select/input dialogs instead.
			const pairs: Array<{ question: string; answer: string }> = [];

			for (const q of questions) {
				if (q.multiSelect) {
					const selected = new Set<number>();
					for (;;) {
						const items = multiSelectItems(q, selected);
						const doneItem = items[items.length - 1];
						const choice = await ctx.ui.select(titleFor(q, selected.size), items, { signal });
						if (choice === undefined) {
							throw new Error("User dismissed the question");
						}
						if (choice === doneItem) {
							break;
						}
						const toggleIndex = toggleIndexForItem(items.indexOf(choice));
						if (selected.has(toggleIndex)) {
							selected.delete(toggleIndex);
						} else {
							selected.add(toggleIndex);
						}
					}

					let otherText: string | undefined;
					if (selected.has(q.options.length)) {
						const typed = await ctx.ui.input(q.question, "Type your answer", { signal });
						if (typed === undefined) {
							throw new Error("User dismissed the question");
						}
						if (typed.trim()) otherText = typed.trim();
					}

					const labels = [...selected]
						.filter((i) => i < q.options.length)
						.sort((a, b) => a - b)
						.map((i) => q.options[i].label);
					if (otherText) labels.push(otherText);
					pairs.push({ question: q.question, answer: joinMultiSelectAnswer(labels) });
				} else {
					const items = singleSelectItems(q);
					const otherItem = items[items.length - 1];
					const choice = await ctx.ui.select(titleFor(q), items, { signal });
					if (choice === undefined) {
						throw new Error("User dismissed the question");
					}
					if (choice === otherItem) {
						const typed = await ctx.ui.input(q.question, "Type your answer", { signal });
						if (!typed?.trim()) {
							throw new Error("User dismissed the question");
						}
						pairs.push({ question: q.question, answer: typed.trim() });
					} else {
						const option = q.options[items.indexOf(choice)];
						pairs.push({ question: q.question, answer: option.label });
					}
				}
			}

			return { content: [{ type: "text", text: formatAnswers(pairs) }], details: undefined };
		},
	});

	// Runtime approval gate for external/destructive shell commands. The host
	// blocks the call unless the user approves it right here, so the model needs
	// no approval policy and no extra assistant turn. Sibling ports for the other
	// harnesses live in the dotfiles repo: native/claude/hooks (PreToolUse) and
	// native/codex/rules (execpolicy).
	pi.on("tool_call", async (event, ctx) => {
		// Compared by name rather than with `isToolCallEventType`: that helper is a
		// value import from the host package, and keeping this module's host imports
		// type-only is what lets the tests run under plain `node --test`.
		if (event.toolName !== "bash") return;

		const command = String((event.input as { command?: string }).command ?? "");
		const rule = matchExternalAction(command);
		if (!rule) return;

		// Fail closed: a session that cannot ask must not run the command.
		if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD === "1") {
			return {
				block: true,
				reason: `${rule.reason} This session cannot ask for approval, so the command was blocked. Escalate the exact command to the parent agent or the user.`,
			};
		}

		try {
			if (await confirmExternalAction(ctx, rule, command)) return;
		} catch {
			// A dialog failure, dismissal, or abort is not an approval.
		}
		return { block: true, reason: `Not approved by the user: ${rule.reason}` };
	});
}
