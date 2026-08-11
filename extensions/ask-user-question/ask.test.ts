import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clampQuestions,
	dedupeItems,
	DONE_LABEL,
	formatAnswers,
	formatOption,
	joinMultiSelectAnswer,
	moveCursor,
	multiSelectItems,
	OTHER_LABEL,
	type Question,
	singleSelectItems,
	titleFor,
	toggleIndexForItem,
	toggleSelection,
} from "./ask.ts";

function makeQuestion(overrides: Partial<Question> = {}): Question {
	return {
		question: "Which approach?",
		header: "Approach",
		options: [
			{ label: "A", description: "First option" },
			{ label: "B", description: "Second option" },
		],
		...overrides,
	};
}

test("OTHER_LABEL and DONE_LABEL are the documented literals", () => {
	assert.equal(OTHER_LABEL, "Other (type your own answer)");
	assert.equal(DONE_LABEL, "✓ Done");
});

test("clampQuestions keeps at most 4 questions", () => {
	const questions = Array.from({ length: 5 }, (_, i) => makeQuestion({ question: `Q${i}` }));
	const clamped = clampQuestions(questions);
	assert.equal(clamped.length, 4);
	assert.deepEqual(clamped.map((q) => q.question), ["Q0", "Q1", "Q2", "Q3"]);
});

test("clampQuestions keeps at most 4 options per question", () => {
	const options = Array.from({ length: 5 }, (_, i) => ({ label: `Opt${i}`, description: "" }));
	const [clamped] = clampQuestions([makeQuestion({ options })]);
	assert.equal(clamped.options.length, 4);
	assert.deepEqual(clamped.options.map((o) => o.label), ["Opt0", "Opt1", "Opt2", "Opt3"]);
});

test("clampQuestions does not enforce minimums", () => {
	const clamped = clampQuestions([makeQuestion({ options: [] })]);
	assert.equal(clamped.length, 1);
	assert.equal(clamped[0].options.length, 0);
});

test("formatOption joins label and description with an em dash", () => {
	assert.equal(formatOption({ label: "A", description: "First option" }), "A — First option");
});

test("formatOption falls back to just the label when description is empty", () => {
	assert.equal(formatOption({ label: "A", description: "" }), "A");
});

test("singleSelectItems formats options and appends Other last", () => {
	const items = singleSelectItems(makeQuestion());
	assert.deepEqual(items, ["A — First option", "B — Second option", OTHER_LABEL]);
});

test("multiSelectItems prefixes unchecked options and appends Other then Done", () => {
	const items = multiSelectItems(makeQuestion(), new Set());
	assert.deepEqual(items, ["[ ] A — First option", "[ ] B — Second option", `[ ] ${OTHER_LABEL}`, DONE_LABEL]);
});

test("multiSelectItems checks selected options and a selected Other, Done always last", () => {
	const items = multiSelectItems(makeQuestion(), new Set([0, 2]));
	assert.deepEqual(items, ["[x] A — First option", "[ ] B — Second option", `[x] ${OTHER_LABEL}`, DONE_LABEL]);
	assert.equal(items[items.length - 1], DONE_LABEL);
});

test("dedupeItems leaves unique items unchanged", () => {
	assert.deepEqual(dedupeItems(["A", "B", "C"]), ["A", "B", "C"]);
});

test("dedupeItems appends (2), (3)... to repeats, first occurrence unchanged", () => {
	assert.deepEqual(dedupeItems(["A", "A", "A", "B"]), ["A", "A (2)", "A (3)", "B"]);
});

test("singleSelectItems dedupes an option that collides with OTHER_LABEL", () => {
	const q = makeQuestion({
		options: [
			{ label: OTHER_LABEL, description: "" },
			{ label: "B", description: "" },
		],
	});
	const items = singleSelectItems(q);
	assert.deepEqual(items, [OTHER_LABEL, "B", `${OTHER_LABEL} (2)`]);
	// The real "Other" entry is distinguishable at the last position, not by string equality.
	assert.equal(items[items.length - 1], `${OTHER_LABEL} (2)`);
});

test("multiSelectItems dedupes two options with identical formatted text", () => {
	const q = makeQuestion({
		options: [
			{ label: "A", description: "" },
			{ label: "A", description: "" },
		],
	});
	const items = multiSelectItems(q, new Set());
	assert.deepEqual(items, ["[ ] A", "[ ] A (2)", `[ ] ${OTHER_LABEL}`, DONE_LABEL]);
});

test("dedupeItems stays unique when an input already carries a (n) suffix", () => {
	const items = dedupeItems(["A", "A (2)", "A"]);
	assert.equal(new Set(items).size, items.length);
	assert.deepEqual(items, ["A", "A (2)", "A (3)"]);
});

test("singleSelectItems and multiSelectItems stay unique when options are crafted as OTHER_LABEL and OTHER_LABEL + ' (2)'", () => {
	const q = makeQuestion({
		options: [
			{ label: OTHER_LABEL, description: "" },
			{ label: `${OTHER_LABEL} (2)`, description: "" },
		],
	});

	const single = singleSelectItems(q);
	assert.equal(new Set(single).size, single.length);

	const multi = multiSelectItems(q, new Set());
	assert.equal(new Set(multi).size, multi.length);
});

test("multiSelectItems dedupes an option that collides with the Other entry", () => {
	const q = makeQuestion({
		options: [
			{ label: OTHER_LABEL, description: "" },
			{ label: "B", description: "" },
		],
	});
	const items = multiSelectItems(q, new Set());
	assert.deepEqual(items, [`[ ] ${OTHER_LABEL}`, "[ ] B", `[ ] ${OTHER_LABEL} (2)`, DONE_LABEL]);
	// The real "Other" entry is distinguishable at index q.options.length, not by string equality.
	assert.equal(items[q.options.length], `[ ] ${OTHER_LABEL} (2)`);
});

test("toggleIndexForItem is a trivial identity mapping", () => {
	assert.equal(toggleIndexForItem(0), 0);
	assert.equal(toggleIndexForItem(2), 2);
});

test("moveCursor steps by ±1 within range", () => {
	assert.equal(moveCursor(1, 1, 4), 2);
	assert.equal(moveCursor(1, -1, 4), 0);
});

test("moveCursor clamps at the top row", () => {
	assert.equal(moveCursor(0, -1, 4), 0);
});

test("moveCursor clamps at the bottom row", () => {
	assert.equal(moveCursor(3, 1, 4), 3);
});

test("toggleSelection adds an unselected index", () => {
	const result = toggleSelection(new Set([0]), 1);
	assert.deepEqual([...result].sort(), [0, 1]);
});

test("toggleSelection removes an already-selected index", () => {
	const result = toggleSelection(new Set([0, 1]), 1);
	assert.deepEqual([...result], [0]);
});

test("toggleSelection does not mutate the input set", () => {
	const original = new Set([0]);
	toggleSelection(original, 1);
	assert.deepEqual([...original], [0]);
});

test("titleFor formats single-select as question (header)", () => {
	assert.equal(titleFor(makeQuestion()), "Which approach? (Approach)");
});

test("titleFor formats multiSelect as question (n selected)", () => {
	const q = makeQuestion({ multiSelect: true });
	assert.equal(titleFor(q, 0), "Which approach? (0 selected)");
	assert.equal(titleFor(q, 2), "Which approach? (2 selected)");
});

test("titleFor defaults selectedCount to 0 for multiSelect when omitted", () => {
	assert.equal(titleFor(makeQuestion({ multiSelect: true })), "Which approach? (0 selected)");
});

test("formatAnswers formats a single pair", () => {
	assert.equal(formatAnswers([{ question: "q1", answer: "a1" }]), 'Your questions have been answered: "q1"="a1"');
});

test("formatAnswers formats multiple pairs comma-joined", () => {
	assert.equal(
		formatAnswers([
			{ question: "q1", answer: "a1" },
			{ question: "q2", answer: "a2" },
		]),
		'Your questions have been answered: "q1"="a1", "q2"="a2"',
	);
});

test("formatAnswers escapes embedded double quotes in question and answer", () => {
	assert.equal(
		formatAnswers([{ question: 'Use "quotes"?', answer: 'Yes, the "default" one' }]),
		'Your questions have been answered: "Use \\"quotes\\"?"="Yes, the \\"default\\" one"',
	);
});

// Built from an explicit single-character constant (rather than dense escaped
// literals) so the expected values below are easy to verify by inspection.
const BACKSLASH = String.fromCharCode(92);

test("formatAnswers escapes a trailing backslash so the closing quote stays unambiguous", () => {
	const answer = `C:${BACKSLASH}path${BACKSLASH}`; // actual: C:\path\
	const expectedAnswer = `C:${BACKSLASH}${BACKSLASH}path${BACKSLASH}${BACKSLASH}`; // each \ doubled
	assert.equal(
		formatAnswers([{ question: "q1", answer }]),
		`Your questions have been answered: "q1"="${expectedAnswer}"`,
	);
});

test("formatAnswers escapes an embedded backslash-quote sequence", () => {
	const answer = `literal ${BACKSLASH}" here`; // actual: literal \" here
	// backslash escaped first (-> 2 backslashes), then the quote is escaped (-> \"), giving 3 backslashes then a quote
	const expectedAnswer = `literal ${BACKSLASH}${BACKSLASH}${BACKSLASH}" here`;
	assert.equal(
		formatAnswers([{ question: "q1", answer }]),
		`Your questions have been answered: "q1"="${expectedAnswer}"`,
	);
});

test("joinMultiSelectAnswer comma-joins labels", () => {
	assert.equal(joinMultiSelectAnswer(["A"]), "A");
	assert.equal(joinMultiSelectAnswer(["A", "B"]), "A, B");
});

test("joinMultiSelectAnswer falls back to a placeholder when nothing is selected", () => {
	assert.equal(joinMultiSelectAnswer([]), "(no options selected)");
});
