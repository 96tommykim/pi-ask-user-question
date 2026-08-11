/**
 * multiSelect dialog — one persistent `ctx.ui.custom` component.
 *
 * Re-opening a fresh `ctx.ui.select` per toggle (the RPC fallback in
 * index.ts still does this) flickers the whole screen and resets the
 * cursor to the first row on every toggle. In TUI mode this component is
 * used instead: a single Component stays alive for the whole question,
 * and toggling/moving the cursor just invalidates a render cache.
 */

import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { moveCursor, OTHER_LABEL, type Question, titleFor, toggleSelection } from "./ask.ts";

/**
 * Show the multiSelect dialog for `q` and resolve with the set of toggled
 * row indices (options at 0..q.options.length-1, "Other" at
 * q.options.length), or `undefined` if the user cancelled (Escape, or
 * `signal` aborting).
 */
export function promptMultiSelect(
	ctx: ExtensionContext,
	q: Question,
	signal?: AbortSignal,
): Promise<Set<number> | undefined> {
	// Match the host's own dialogs (interactive-mode.js showExtensionSelector/showExtensionInput):
	// an already-aborted signal must resolve immediately instead of opening a dialog nobody
	// can dismiss (an `abort` listener added after the fact never fires for a past abort).
	if (signal?.aborted) return Promise.resolve(undefined);

	return ctx.ui.custom<Set<number> | undefined>((_tui, theme, keybindings: KeybindingsManager, done) => {
		const rowCount = q.options.length + 1; // options + Other
		let cursor = 0;
		let selected = new Set<number>();
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

		const onAbort = () => done(undefined);
		signal?.addEventListener("abort", onAbort);

		function invalidate() {
			cachedLines = undefined;
		}

		// Mirrors the precedence used by the host's own ExtensionSelectorComponent
		// (dist/modes/interactive/components/extension-selector.js ~58-79): check the
		// user's resolved tui.select.* keybinding first, then the vim-style / literal
		// fallback, in addition to (not instead of) our own hardcoded arrow/enter/escape
		// keys and the toggle-only "space" key, which the host selector has no equivalent of.
		function handleInput(data: string) {
			if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.select.up") || data === "k") {
				cursor = moveCursor(cursor, -1, rowCount);
				invalidate();
				return;
			}
			if (matchesKey(data, Key.down) || keybindings.matches(data, "tui.select.down") || data === "j") {
				cursor = moveCursor(cursor, 1, rowCount);
				invalidate();
				return;
			}
			if (matchesKey(data, Key.space)) {
				selected = toggleSelection(selected, cursor);
				invalidate();
				return;
			}
			if (matchesKey(data, Key.enter) || keybindings.matches(data, "tui.select.confirm") || data === "\n") {
				done(new Set(selected));
				return;
			}
			if (matchesKey(data, Key.escape) || keybindings.matches(data, "tui.select.cancel")) {
				done(undefined);
			}
		}

		function addWrapped(lines: string[], text: string, width: number) {
			lines.push(...wrapTextWithAnsi(text, width));
		}

		function addWrappedWithPrefix(lines: string[], prefix: string, text: string, width: number) {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= width) {
				addWrapped(lines, prefix + text, width);
				return;
			}
			const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
			const continuationPrefix = " ".repeat(prefixWidth);
			for (let i = 0; i < wrapped.length; i++) {
				lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
			}
		}

		function addRow(lines: string[], width: number, index: number, label: string, description: string) {
			const isCursor = index === cursor;
			const prefix = isCursor ? theme.fg("accent", "> ") : "  ";
			const checkbox = selected.has(index) ? "[x] " : "[ ] ";
			const color = isCursor ? "accent" : "text";
			const labelText = theme.fg(color, `${checkbox}${label}`);
			const descText = description ? theme.fg("muted", ` — ${description}`) : "";
			addWrappedWithPrefix(lines, prefix, labelText + descText, width);
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;

			const renderWidth = Math.max(1, width);
			const lines: string[] = [];

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			addWrappedWithPrefix(lines, " ", theme.fg("accent", titleFor(q, selected.size)), renderWidth);
			lines.push("");

			for (let i = 0; i < q.options.length; i++) {
				addRow(lines, renderWidth, i, q.options[i].label, q.options[i].description);
			}
			addRow(lines, renderWidth, q.options.length, OTHER_LABEL, "");

			lines.push("");
			addWrappedWithPrefix(
				lines,
				" ",
				theme.fg("dim", "↑↓ move · space toggle · enter confirm · esc cancel"),
				renderWidth,
			);
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			cachedWidth = width;
			cachedLines = lines;
			return lines;
		}

		return {
			render,
			handleInput,
			invalidate,
			dispose() {
				signal?.removeEventListener("abort", onAbort);
			},
		};
	});
}
