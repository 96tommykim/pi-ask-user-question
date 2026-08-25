import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const mockTui = `data:text/javascript,${encodeURIComponent(`
	export const CURSOR_MARKER = "\\x1b_pi:c\\x07";
	const ANSI = /\\x1b\\[[0-?]*[ -/]*[@-~]/g;
	const CONTROL = /^(?:\\x1b\\[[0-?]*[ -/]*[@-~]|\\x1b_pi:c\\x07)/;
	const WIDE = /[\\u1100-\\u115f\\u2e80-\\ua4cf\\uac00-\\ud7a3\\uf900-\\ufaff\\uff01-\\uff60\\uffe0-\\uffe6]/;
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	function widthOf(grapheme) { return WIDE.test(grapheme) ? 2 : 1; }
	function tokens(text) {
		const result = [];
		for (let index = 0; index < text.length;) {
			const control = text.slice(index).match(CONTROL)?.[0];
			if (control) { result.push([control, 0]); index += control.length; continue; }
			let end = index + 1;
			while (end < text.length && !text.slice(end).match(CONTROL)) end++;
			for (const { segment } of segmenter.segment(text.slice(index, end))) result.push([segment, widthOf(segment)]);
			index = end;
		}
		return result;
	}
	export function visibleWidth(text) {
		return tokens(text).reduce((width, [, tokenWidth]) => width + tokenWidth, 0);
	}
	export function truncateToWidth(text, width) {
		let output = "";
		let used = 0;
		for (const [token, tokenWidth] of tokens(text)) {
			if (tokenWidth === 0 || used + tokenWidth <= width) { output += token; used += tokenWidth; }
		}
		return output;
	}
	export function wrapTextWithAnsi(text, width) {
		const lines = [];
		let line = "";
		let used = 0;
		for (const [token, tokenWidth] of tokens(text)) {
			if (tokenWidth && used && used + tokenWidth > width) { lines.push(line); line = ""; used = 0; }
			line += token;
			used += tokenWidth;
		}
		lines.push(line);
		return lines;
	}
	export const Key = { escape: "escape", tab: "tab", right: "right", left: "left", up: "up", down: "down", space: "space", enter: "enter", shift: (key) => "shift " + key };
	export function matchesKey(data, key) { return data === key; }
	export class Editor {
		constructor() { this.focused = false; this.text = ""; this.onSubmit = undefined; }
		setText(text) { this.text = text; }
		handleInput(data) { if (data === "enter") this.onSubmit?.(this.text); else this.text += data; }
		render(width) { return wrapTextWithAnsi(this.text + (this.focused ? CURSOR_MARKER : ""), width); }
	}
`)}`;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-tui" && context.parentURL.includes("/extensions/ask-user-question/dialog.ts")) {
			return { shortCircuit: true, url: mockTui };
		}
		return nextResolve(specifier, context);
	},
});

const { promptQuestions } = await import(new URL("./dialog.ts", import.meta.url).href);
const CURSOR_MARKER = "\x1b_pi:c\x07";
const ANSI_OR_APC = /\x1b(?:\[[0-?]*[ -/]*[@-~]|_pi:c\x07)/g;
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type Component = {
	focused: boolean;
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
};

function makeQuestion(multiSelect = false) {
	return {
		question: "請選擇一個包含很長內容的選項，以驗證捲動視窗與組合字元 é。",
		header: "確認",
		options: Array.from({ length: 4 }, (_, index) => ({
			label: `選項 ${index + 1}`,
			description: `這是一段很長的說明文字 ${"內容 ".repeat(12)}`,
		})),
		...(multiSelect ? { multiSelect: true } : {}),
	};
}

function open(rows: number, width = 80, questions = [makeQuestion()], signal?: AbortSignal) {
	let component: Component | undefined;
	let doneValue: unknown;
	const tui = { terminal: { rows }, requestRender() {} };
	const theme = {
		fg(color: string, text: string) {
			return `\x1b[38;5;${color === "accent" ? 45 : 250}m${text}\x1b[0m`;
		},
		bg(_color: string, text: string) {
			return `\x1b[48;5;238m${text}\x1b[0m`;
		},
	};
	const keybindings = {
		matches(data: string, action: string) {
			return (action === "tui.select.up" && data === "up") || (action === "tui.select.down" && data === "down") || (action === "tui.select.confirm" && data === "enter") || (action === "tui.select.cancel" && data === "cancel");
		},
	};
	const ctx = {
		ui: {
			custom(factory: (tui: typeof tui, theme: typeof theme, keybindings: typeof keybindings, done: (value: unknown) => void) => Component) {
				return new Promise<unknown>((resolve) => {
					component = factory(tui, theme, keybindings, (value) => {
						doneValue = value;
						resolve(value);
					});
				});
			},
		},
	};
	const result = promptQuestions(ctx as never, questions as never, signal);
	if (!component) throw new Error("dialog component was not created");
	return { component, doneValue: () => doneValue, result, tui, width };
}

function heightCap(rows: number) {
	return Math.max(1, rows - 2);
}

function stripControls(text: string) {
	return text.replace(ANSI_OR_APC, "");
}

function visibleWidth(text: string) {
	return [...segmenter.segment(stripControls(text))].reduce((total, { segment }) => total + (WIDE.test(segment) ? 2 : 1), 0);
}

function assertWidthSafe(lines: string[], width: number) {
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns: ${stripControls(line)}`);
}

test("dialog wraps ANSI/CJK content, keeps indicators and footer within the terminal cap, and reacts to resize", async () => {
	const { component, result, tui, width } = open(8, 32);
	let lines = component.render(width);
	assert.ok(lines.every((line) => !line.includes(CURSOR_MARKER)), "unfocused render has no cursor marker");

	component.focused = true;
	for (let index = 0; index < 3; index++) component.handleInput("down");
	lines = component.render(width);
	assert.ok(lines.length <= heightCap(tui.terminal.rows));
	assert.match(stripControls(lines.at(-1) ?? ""), /↑↓ move.*enter select/);
	assert.ok(lines.some((line) => /^[↑↓] \d+ more/.test(stripControls(line))), "overflow indicator is rendered");
	assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1, "validated content cannot add a second APC marker");
	assert.ok(lines.some((line) => line.includes("\x1b[")), "theme ANSI is retained");
	assert.ok(stripControls(lines.join("")).includes("選項"), "CJK row remains in the viewport");
	assertWidthSafe(lines, width);

	component.focused = false;
	lines = component.render(width);
	assert.ok(lines.every((line) => !line.includes(CURSOR_MARKER)), "focus setter invalidates cached marker lines");
	component.focused = true;

	tui.terminal.rows = 4;
	lines = component.render(width);
	assert.ok(lines.length <= heightCap(tui.terminal.rows), "render cache includes terminal height without explicit invalidation");
	assert.match(stripControls(lines.at(-1) ?? ""), /↑↓ move.*enter select/);
	assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));

	component.handleInput("escape");
	assert.equal(await result, undefined);
});

test("dialog keeps the Other editor cursor visible and submits its typed answer", async () => {
	const { component, result, tui, width } = open(8, 80);
	component.focused = true;
	for (let index = 0; index < 4; index++) component.handleInput("down");
	component.handleInput("enter");

	let lines = component.render(width);
	assert.ok(lines.length <= heightCap(tui.terminal.rows));
	assert.match(stripControls(lines.at(-1) ?? ""), /enter submit.*esc back/);
	assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));

	component.handleInput("custom answer");
	component.handleInput("enter");
	assert.deepEqual(await result, [{ question: makeQuestion().question, answer: "custom answer" }]);
});

test("dialog completes multiSelect answers and settles cancellation and abort through custom done", async () => {
	const selected = open(8, 80, [makeQuestion(true)]);
	selected.component.focused = true;
	selected.component.handleInput("space");
	selected.component.handleInput("enter");
	assert.deepEqual(await selected.result, [{ question: makeQuestion().question, answer: "選項 1" }]);
	assert.deepEqual(selected.doneValue(), [{ question: makeQuestion().question, answer: "選項 1" }]);

	const cancelled = open(8);
	cancelled.component.handleInput("escape");
	assert.equal(await cancelled.result, undefined);
	assert.equal(cancelled.doneValue(), undefined);

	const controller = new AbortController();
	const aborted = open(8, 80, [makeQuestion()], controller.signal);
	controller.abort();
	assert.equal(await aborted.result, undefined);
	assert.equal(aborted.doneValue(), undefined);
});

test("dialog completes multiple TUI questions in original order and distinguishes Esc input backout from Ctrl+C", async () => {
	const first = { question: "First?", header: "First", options: [{ label: "A", description: "" }, { label: "B", description: "" }] };
	const second = { question: "Second?", header: "Second", options: [{ label: "C", description: "" }, { label: "D", description: "" }] };
	const multiple = open(8, 80, [first, second]);
	multiple.component.handleInput("enter");
	multiple.component.handleInput("down");
	multiple.component.handleInput("enter");
	assert.deepEqual(await multiple.result, [{ question: "First?", answer: "A" }, { question: "Second?", answer: "D" }]);

	const input = open(8, 80);
	input.component.focused = true;
	for (let index = 0; index < 4; index++) input.component.handleInput("down");
	input.component.handleInput("enter");
	input.component.handleInput("escape");
	let settled = false;
	void input.result.then(() => { settled = true; });
	await Promise.resolve();
	assert.equal(settled, false, "Esc only leaves Other input mode");
	assert.match(stripControls(input.component.render(80).at(-1) ?? ""), /enter select/);
	input.component.handleInput("cancel");
	assert.equal(await input.result, undefined, "Ctrl+C cancellation closes the dialog");
});

test("dialog skips pre-aborted signals and removes abort listeners on disposal", async () => {
	let customCalls = 0;
	const preAborted = await promptQuestions({ ui: { custom() { customCalls++; throw new Error("must not open"); } } } as never, [makeQuestion()] as never, AbortSignal.abort());
	assert.equal(preAborted, undefined);
	assert.equal(customCalls, 0);

	const listeners = new Set<() => void>();
	const signal = {
		aborted: false,
		addEventListener(type: string, listener: () => void) { if (type === "abort") listeners.add(listener); },
		removeEventListener(type: string, listener: () => void) { if (type === "abort") listeners.delete(listener); },
	};
	const opened = open(8, 80, [makeQuestion()], signal as never);
	assert.equal(listeners.size, 1);
	opened.component.dispose();
	assert.equal(listeners.size, 0);
	opened.component.handleInput("escape");
	assert.equal(await opened.result, undefined);
});

test("dialog uses the one-row focused-body fallback without an action footer", async () => {
	const { component, result, tui, width } = open(3, 80);
	component.focused = true;
	for (let index = 0; index < 4; index++) component.handleInput("down");

	const lines = component.render(width);
	assert.equal(lines.length, heightCap(tui.terminal.rows));
	assert.ok(lines[0].includes(CURSOR_MARKER));
	assert.doesNotMatch(stripControls(lines[0]), /↑↓ move|enter select|esc cancel/);

	component.handleInput("escape");
	assert.equal(await result, undefined);
});
