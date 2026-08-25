/**
 * ask_user_question — pure logic
 *
 * No imports from Pi packages or typebox, so this runs under plain
 * `node --test` without the host runtime installed.
 */

export const OTHER_LABEL = "Other (type your own answer)";
export const DONE_LABEL = "✓ Done";

export interface Option {
	label: string;
	description: string;
}

export interface Question {
	question: string;
	header: string;
	options: Option[];
	multiSelect?: boolean;
}

export type QuestionValidation = { ok: true; questions: Question[] } | { ok: false; error: string };

/** Keep at most 4 questions, at most 4 options each. No minimums enforced. */
export function clampQuestions(questions: Question[]): Question[] {
	return questions.slice(0, 4).map((q) => ({ ...q, options: q.options.slice(0, 4) }));
}

/**
 * Validate untrusted tool arguments before UI code reads them. TypeBox describes
 * the model-facing schema, but the host can still call an extension with values
 * that have not passed that validation. Oversized arrays retain the historic
 * max-four clamping; invalid minima and field types are rejected clearly.
 */
export function validateQuestions(value: unknown): QuestionValidation {
	if (!Array.isArray(value)) return { ok: false, error: "questions must be a non-empty array." };
	if (value.length === 0) return { ok: false, error: "questions must contain at least one question." };

	const questions: Question[] = [];
	for (const [questionIndex, rawQuestion] of value.slice(0, 4).entries()) {
		if (!isRecord(rawQuestion)) return { ok: false, error: `questions[${questionIndex}] must be an object.` };
		if (typeof rawQuestion.question !== "string" || !rawQuestion.question.trim()) {
			return { ok: false, error: `questions[${questionIndex}].question must be a non-empty string.` };
		}
		if (typeof rawQuestion.header !== "string" || !rawQuestion.header.trim()) {
			return { ok: false, error: `questions[${questionIndex}].header must be a non-empty string.` };
		}
		if (!Array.isArray(rawQuestion.options)) {
			return { ok: false, error: `questions[${questionIndex}].options must be an array with 2 to 4 options.` };
		}

		const options: Option[] = [];
		for (const [optionIndex, rawOption] of rawQuestion.options.slice(0, 4).entries()) {
			if (!isRecord(rawOption)) return { ok: false, error: `questions[${questionIndex}].options[${optionIndex}] must be an object.` };
			if (typeof rawOption.label !== "string" || !rawOption.label.trim()) {
				return { ok: false, error: `questions[${questionIndex}].options[${optionIndex}].label must be a non-empty string.` };
			}
			if (typeof rawOption.description !== "string") {
				return { ok: false, error: `questions[${questionIndex}].options[${optionIndex}].description must be a string.` };
			}
			options.push({ label: rawOption.label, description: rawOption.description });
		}
		if (options.length < 2) {
			return { ok: false, error: `questions[${questionIndex}].options must contain at least 2 options.` };
		}
		if (rawQuestion.multiSelect !== undefined && typeof rawQuestion.multiSelect !== "boolean") {
			return { ok: false, error: `questions[${questionIndex}].multiSelect must be a boolean when provided.` };
		}
		questions.push({
			question: rawQuestion.question,
			header: rawQuestion.header,
			options,
			...(rawQuestion.multiSelect === undefined ? {} : { multiSelect: rawQuestion.multiSelect }),
		});
	}
	return { ok: true, questions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "label — description", or just "label" when description is empty. */
export function formatOption(o: Option): string {
	return o.description ? `${o.label} — ${o.description}` : o.label;
}

/**
 * Append " (2)", " (3)", … to repeated strings so every item is unique
 * (first occurrence unchanged). Applied over the full item list — including
 * OTHER_LABEL/DONE_LABEL — so a user-supplied option can never render
 * identically to, and hijack, the built-in Other/Done entries. Probes
 * upward from " (2)" until the candidate is actually unseen, so an input
 * that already carries a " (n)" suffix (e.g. crafted to collide with a
 * previously deduped item) still ends up unique.
 */
export function dedupeItems(items: string[]): string[] {
	const seen = new Set<string>();
	return items.map((item) => {
		let candidate = item;
		let k = 2;
		while (seen.has(candidate)) candidate = `${item} (${k++})`;
		seen.add(candidate);
		return candidate;
	});
}

/** Formatted options followed by the "Other" free-text entry, last. */
export function singleSelectItems(q: Question): string[] {
	return dedupeItems([...q.options.map(formatOption), OTHER_LABEL]);
}

/**
 * Checkbox-prefixed formatted options, then the checkbox-prefixed "Other"
 * entry (toggles like any other option, at index = options.length), then
 * "Done" last (not a toggle target).
 */
export function multiSelectItems(q: Question, selected: Set<number>): string[] {
	const optionItems = q.options.map((o, i) => `${selected.has(i) ? "[x] " : "[ ] "}${formatOption(o)}`);
	const otherItem = `${selected.has(q.options.length) ? "[x] " : "[ ] "}${OTHER_LABEL}`;
	return dedupeItems([...optionItems, otherItem, DONE_LABEL]);
}

/** Identity mapping from a select result index to a toggle index (Done is never passed in). */
export function toggleIndexForItem(itemIndex: number): number {
	return itemIndex;
}

/** Move a cursor by ±1 over `rowCount` rows, clamped to [0, rowCount - 1]. */
export function moveCursor(current: number, delta: -1 | 1, rowCount: number): number {
	if (rowCount <= 0) return 0;
	return Math.max(0, Math.min(rowCount - 1, current + delta));
}

/** Returns a new Set with `index` toggled in or out of `selected` (does not mutate `selected`). */
export function toggleSelection(selected: Set<number>, index: number): Set<number> {
	const next = new Set(selected);
	if (next.has(index)) {
		next.delete(index);
	} else {
		next.add(index);
	}
	return next;
}

/**
 * Next index after `from` (wrapping) that is not in `answered`; `undefined`
 * once every one of the `count` questions is answered.
 */
export function nextUnanswered(answered: Set<number>, count: number, from: number): number | undefined {
	if (count <= 0) return undefined;
	for (let step = 1; step <= count; step++) {
		const index = (from + step) % count;
		if (!answered.has(index)) return index;
	}
	return undefined;
}

/** Wraps `current + delta` into [0, count - 1]. */
export function switchQuestion(current: number, delta: -1 | 1, count: number): number {
	if (count <= 0) return 0;
	return (current + delta + count) % count;
}

/** Comma-joins selected labels; "(no options selected)" when the list is empty. */
export function joinMultiSelectAnswer(labels: string[]): string {
	return labels.length > 0 ? labels.join(", ") : "(no options selected)";
}

/** Single-select: "question (header)". MultiSelect: "question (n selected)". */
export function titleFor(q: Question, selectedCount?: number): string {
	if (q.multiSelect) {
		return `${q.question} (${selectedCount ?? 0} selected)`;
	}
	return `${q.question} (${q.header})`;
}

/**
 * `Your questions have been answered: "q1"="a1", "q2"="a2"` — embedded
 * backslashes and double quotes are escaped, backslashes first, so a
 * trailing `\` or an embedded `\"` can't make the closing quote ambiguous.
 */
export function formatAnswers(pairs: Array<{ question: string; answer: string }>): string {
	const escape = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
	const parts = pairs.map((p) => `"${escape(p.question)}"="${escape(p.answer)}"`);
	return `Your questions have been answered: ${parts.join(", ")}`;
}
