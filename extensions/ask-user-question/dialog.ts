/**
 * Unified tabbed dialog for the whole `ask_user_question` call — one
 * persistent `ctx.ui.custom` component covering every question, closely
 * following the pi-coding-agent `questionnaire.ts` example (tab bar with
 * ■/□ answered markers, tab/←→ navigation, inline free-text via the pi-tui
 * `Editor`, cachedLines + refresh()).
 *
 * TUI-only. The RPC fallback in index.ts stays a sequential per-question
 * select-loop and does not use this module.
 */

import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, type EditorTheme, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	joinMultiSelectAnswer,
	moveCursor,
	nextUnanswered,
	OTHER_LABEL,
	type Question,
	switchQuestion,
	toggleSelection,
} from "./ask.ts";
import { calculateStickyFooterViewport, viewportIndicator } from "./viewport.ts";

interface QuestionState {
	cursor: number;
	selected: Set<number>;
	answer: string | undefined;
}

/**
 * Show one tabbed dialog for all `questions` and resolve with the answered
 * `{ question, answer }` pairs in original question order, or `undefined`
 * if the user cancelled (Escape outside input mode, or `signal` aborting).
 */
export function promptQuestions(
	ctx: ExtensionContext,
	questions: Question[],
	signal?: AbortSignal,
): Promise<Array<{ question: string; answer: string }> | undefined> {
	// Match the host's own dialogs (interactive-mode.js showExtensionSelector/showExtensionInput):
	// an already-aborted signal must resolve immediately instead of opening a dialog nobody
	// can dismiss (an `abort` listener added after the fact never fires for a past abort).
	if (signal?.aborted) return Promise.resolve(undefined);

	return ctx.ui.custom<Array<{ question: string; answer: string }> | undefined>(
		(tui, theme, keybindings: KeybindingsManager, done) => {
			const showTabs = questions.length > 1;
			const states: QuestionState[] = questions.map(() => ({ cursor: 0, selected: new Set<number>(), answer: undefined }));
			let currentTab = 0;
			let inputMode = false;
			// Set while an inline text input was opened by confirming a multiSelect question
			// with "Other" toggled on; undefined when input mode was opened from the single-
			// select Other row instead, which needs different Esc/blank handling. Esc or a blank
			// submit while this is set just untoggles Other and returns to the option list
			// (no answer is recorded) — the user presses enter again to confirm without Other.
			let multiSelectPendingIndex: number | undefined;
			let cachedWidth: number | undefined;
			let cachedHeight: number | undefined;
			let cachedLines: string[] | undefined;
			let componentFocused = false;

			const editorTheme: EditorTheme = {
				borderColor: (s) => theme.fg("accent", s),
				selectList: {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
			};
			const editor = new Editor(tui, editorTheme);

			const onAbort = () => done(undefined);
			signal?.addEventListener("abort", onAbort);

			function refresh() {
				cachedLines = undefined;
				// The custom dialog remains the TUI's focused component so it can
				// intercept Esc, but its embedded Editor must still emit Pi's cursor
				// marker for IME/cursor positioning while Other is active.
				editor.focused = componentFocused && inputMode;
				tui.requestRender();
			}

			function isAnswered(index: number): boolean {
				return states[index].answer !== undefined;
			}

			function recordAnswer(index: number, answer: string) {
				states[index].answer = answer;
			}

			// Un-answering a question clears its ■ chip; the user must re-confirm with enter
			// before it counts again. Used whenever a question's recorded answer no longer
			// matches what's on screen (checkbox toggled after answering, Other dropped).
			function unanswer(index: number) {
				states[index].answer = undefined;
			}

			function advance(fromIndex: number) {
				const answered = new Set(questions.map((_, i) => i).filter(isAnswered));
				const next = nextUnanswered(answered, questions.length, fromIndex);
				if (next === undefined) {
					done(questions.map((q, i) => ({ question: q.question, answer: states[i].answer ?? "" })));
					return;
				}
				currentTab = next;
				refresh();
			}

			function finalizeMultiSelect(index: number, otherText: string | undefined) {
				const q = questions[index];
				const state = states[index];
				const labels = [...state.selected]
					.filter((i) => i < q.options.length)
					.sort((a, b) => a - b)
					.map((i) => q.options[i].label);
				if (otherText) labels.push(otherText);
				recordAnswer(index, joinMultiSelectAnswer(labels));
				advance(index);
			}

			function confirmMultiSelect(index: number) {
				const q = questions[index];
				const state = states[index];
				if (state.selected.has(q.options.length)) {
					multiSelectPendingIndex = index;
					inputMode = true;
					editor.setText("");
					refresh();
					return;
				}
				finalizeMultiSelect(index, undefined);
			}

			editor.onSubmit = (value) => {
				const trimmed = value.trim();
				if (multiSelectPendingIndex !== undefined) {
					const index = multiSelectPendingIndex;
					const q = questions[index];
					const state = states[index];
					multiSelectPendingIndex = undefined;
					inputMode = false;
					editor.setText("");
					if (!trimmed) {
						// Other was toggled on but the free text was left blank: drop it from the
						// selection (so revisiting shows it unchecked) and go back to the option
						// list WITHOUT finalizing — the question stays unanswered until the user
						// presses enter again to confirm.
						state.selected = toggleSelection(state.selected, q.options.length);
						unanswer(index);
						refresh();
						return;
					}
					finalizeMultiSelect(index, trimmed);
					return;
				}

				// Single-select "Other" input: a blank submit just leaves input mode, same as Esc.
				inputMode = false;
				editor.setText("");
				if (!trimmed) {
					refresh();
					return;
				}
				const index = currentTab;
				recordAnswer(index, trimmed);
				advance(index);
			};

			function handleInput(data: string) {
				if (inputMode) {
					// Esc backs out of input mode only. Checked before the cancel keybinding
					// (whose default is ["escape", "ctrl+c"]) so Esc never falls through to the
					// "cancel the whole dialog" branch below and silently records/finalizes an
					// answer the user was trying to abandon.
					if (matchesKey(data, Key.escape)) {
						if (multiSelectPendingIndex !== undefined) {
							const index = multiSelectPendingIndex;
							const q = questions[index];
							const state = states[index];
							multiSelectPendingIndex = undefined;
							inputMode = false;
							editor.setText("");
							state.selected = toggleSelection(state.selected, q.options.length);
							unanswer(index);
							refresh();
							return;
						}
						inputMode = false;
						editor.setText("");
						refresh();
						return;
					}
					// Only Ctrl+C reaches here (Esc was handled above): cancel the whole dialog.
					if (keybindings.matches(data, "tui.select.cancel")) {
						done(undefined);
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				if (showTabs) {
					if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
						currentTab = switchQuestion(currentTab, 1, questions.length);
						refresh();
						return;
					}
					if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
						currentTab = switchQuestion(currentTab, -1, questions.length);
						refresh();
						return;
					}
				}

				const q = questions[currentTab];
				const state = states[currentTab];
				const rowCount = q.options.length + 1; // options + Other

				if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.select.up") || data === "k") {
					state.cursor = moveCursor(state.cursor, -1, rowCount);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down) || keybindings.matches(data, "tui.select.down") || data === "j") {
					state.cursor = moveCursor(state.cursor, 1, rowCount);
					refresh();
					return;
				}

				if (q.multiSelect) {
					if (matchesKey(data, Key.space)) {
						state.selected = toggleSelection(state.selected, state.cursor);
						// The checkboxes on screen no longer match whatever was last confirmed;
						// un-answer so the ■ chip drops back to □ until the user re-confirms.
						unanswer(currentTab);
						refresh();
						return;
					}
					if (matchesKey(data, Key.enter) || keybindings.matches(data, "tui.select.confirm") || data === "\n") {
						confirmMultiSelect(currentTab);
						return;
					}
				} else if (matchesKey(data, Key.enter) || keybindings.matches(data, "tui.select.confirm") || data === "\n") {
					if (state.cursor === q.options.length) {
						multiSelectPendingIndex = undefined;
						inputMode = true;
						editor.setText("");
						refresh();
						return;
					}
					recordAnswer(currentTab, q.options[state.cursor].label);
					advance(currentTab);
					return;
				}

				if (matchesKey(data, Key.escape) || keybindings.matches(data, "tui.select.cancel")) {
					done(undefined);
				}
			}

			function fitLine(text: string, width: number): string {
				// Pi's ANSI/grapheme-aware truncation handles CJK and keeps APC cursor
				// markers intact, unlike String#slice which can split either one.
				const safeWidth = Math.max(1, width);
				const fitted = truncateToWidth(text, safeWidth, "");
				if (!text.includes(CURSOR_MARKER) || fitted.includes(CURSOR_MARKER)) return fitted;
				// At one column an Editor cursor can fall after the truncated glyph.
				// Retain its marker at the visible edge so host clipping and IME still
				// track the focused row instead of silently losing the cursor.
				return `${CURSOR_MARKER}${truncateToWidth(text.replace(CURSOR_MARKER, ""), safeWidth, "")}`;
			}

			function addWrapped(lines: string[], text: string, width: number) {
				for (const line of wrapTextWithAnsi(text, Math.max(1, width))) lines.push(fitLine(line, width));
			}

			function addWrappedWithPrefix(lines: string[], prefix: string, text: string, width: number) {
				const safeWidth = Math.max(1, width);
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= safeWidth) {
					// Keep an oversized selected-row prefix (and its cursor marker) rather
					// than letting indentation produce a line wider than the terminal.
					addWrapped(lines, prefix + text, safeWidth);
					return;
				}
				const wrapped = wrapTextWithAnsi(text, safeWidth - prefixWidth);
				const continuationPrefix = " ".repeat(prefixWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(fitLine(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`, safeWidth));
				}
			}

			function addRow(
				lines: string[],
				width: number,
				state: QuestionState,
				multiSelect: boolean,
				index: number,
				label: string,
				description: string,
			) {
				const isCursor = index === state.cursor;
				// Outside Other input mode, this is the sole cursor marker. Pi's
				// fullscreen layout uses it to retain the selected row when clipping.
				const marker = componentFocused && !inputMode && isCursor ? CURSOR_MARKER : "";
				const prefix = isCursor ? `${marker}${theme.fg("accent", "❯ ")}` : "  ";
				const checkbox = multiSelect ? (state.selected.has(index) ? "[x] " : "[ ] ") : "";
				const color = isCursor ? "accent" : "text";
				const labelText = theme.fg(color, `${checkbox}${label}`);
				const descText = description ? theme.fg("muted", ` — ${description}`) : "";
				addWrappedWithPrefix(lines, prefix, labelText + descText, width);
			}

			function addTabBar(lines: string[], width: number) {
				const parts = ["← "];
				for (let i = 0; i < questions.length; i++) {
					const active = i === currentTab;
					const answered = isAnswered(i);
					const box = answered ? "■" : "□";
					const text = ` ${box} ${questions[i].header} `;
					parts.push(active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text));
					if (i < questions.length - 1) parts.push(theme.fg("muted", "│"));
				}
				parts.push(" →");
				addWrappedWithPrefix(lines, " ", parts.join(""), width);
				lines.push("");
			}

			function hintLine(q: Question): string {
				const nav = showTabs ? "←→ switch question · " : "";
				const action = q.multiSelect ? "space toggle · enter confirm" : "enter select";
				return `${nav}↑↓ move · ${action} · esc cancel`;
			}

			function render(width: number): string[] {
				const renderWidth = Math.max(1, width);
				// Two rows leave room for the host's surrounding editor/footer. The
				// calculation itself still guarantees at least one body row on tiny
				// terminals rather than passing a zero or negative height downstream.
				const viewportHeight = Math.max(1, tui.terminal.rows - 2);
				if (cachedLines && cachedWidth === width && cachedHeight === viewportHeight) return cachedLines;

				const lines: string[] = [];
				const q = questions[currentTab];
				const state = states[currentTab];
				const rowStarts: number[] = [];
				let focusStart = 0;

				lines.push(theme.fg("accent", "─".repeat(renderWidth)));
				if (showTabs) addTabBar(lines, renderWidth);
				addWrappedWithPrefix(lines, " ", theme.fg("text", q.question), renderWidth);
				lines.push("");

				for (let i = 0; i < q.options.length; i++) {
					rowStarts.push(lines.length);
					addRow(lines, renderWidth, state, !!q.multiSelect, i, q.options[i].label, q.options[i].description);
				}
				rowStarts.push(lines.length);
				addRow(lines, renderWidth, state, !!q.multiSelect, q.options.length, OTHER_LABEL, "");
				focusStart = rowStarts[state.cursor] ?? 0;

				lines.push("");
				if (inputMode) {
					addWrappedWithPrefix(lines, " ", theme.fg("muted", "Your answer:"), renderWidth);
					const editorStart = lines.length;
					const editorIndent = renderWidth > 1 ? " " : "";
					const editorLines = editor.render(Math.max(1, renderWidth - visibleWidth(editorIndent)));
					const cursorLine = editorLines.findIndex((line) => line.includes(CURSOR_MARKER));
					for (const line of editorLines) lines.push(fitLine(`${editorIndent}${line}`, renderWidth));
					// The editor's cursor is the useful focused range: its own renderer
					// scrolls long text before this outer viewport is applied.
					focusStart = editorStart + Math.max(0, cursorLine);
				}

				// Wrapping can still yield an over-wide CJK grapheme or a host component
				// line, so normalize every final body line before viewport selection.
				const safeLines = lines.map((line) => fitLine(line, renderWidth));
				const stickyViewport = calculateStickyFooterViewport(safeLines.length, viewportHeight, focusStart);
				const viewport = stickyViewport.body;
				const visible: string[] = [];
				if (viewport.hasAbove) visible.push(fitLine(theme.fg("dim", viewportIndicator("up", viewport.start, renderWidth)), renderWidth));
				visible.push(...safeLines.slice(viewport.start, viewport.end));
				if (viewport.hasBelow) visible.push(fitLine(theme.fg("dim", viewportIndicator("down", safeLines.length - viewport.end, renderWidth)), renderWidth));
				if (stickyViewport.footerVisible) {
					const action = inputMode ? "enter submit · esc back" : hintLine(q);
					visible.push(fitLine(theme.fg("dim", action), renderWidth));
				}

				cachedWidth = width;
				cachedHeight = viewportHeight;
				cachedLines = visible;
				return visible;
			}

			return {
				get focused() {
					return componentFocused;
				},
				set focused(focused: boolean) {
					if (componentFocused === focused) return;
					componentFocused = focused;
					editor.focused = focused && inputMode;
					// TUI.setFocus updates Focusable state but does not request a render.
					// Drop cached cursor-marker lines before explicitly drawing the change.
					cachedLines = undefined;
					tui.requestRender();
				},
				render,
				handleInput,
				invalidate() {
					cachedLines = undefined;
				},
				dispose() {
					signal?.removeEventListener("abort", onAbort);
				},
			};
		},
	);
}
