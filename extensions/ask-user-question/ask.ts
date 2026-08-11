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

/** Keep at most 4 questions, at most 4 options each. No minimums enforced. */
export function clampQuestions(questions: Question[]): Question[] {
	return questions.slice(0, 4).map((q) => ({ ...q, options: q.options.slice(0, 4) }));
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
