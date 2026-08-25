import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateStickyFooterViewport, calculateViewport, viewportIndicator } from "./viewport.ts";

test("viewport starts at the top and indicates content below", () => {
	assert.deepEqual(calculateViewport(20, 6, 0), { start: 0, end: 5, hasAbove: false, hasBelow: true });
});

test("viewport retains top context for a near-top focus", () => {
	assert.deepEqual(calculateViewport(4, 3, 1), { start: 0, end: 2, hasAbove: false, hasBelow: true });
});

test("viewport clamps at the bottom and indicates content above", () => {
	assert.deepEqual(calculateViewport(20, 6, 19), { start: 15, end: 20, hasAbove: true, hasBelow: false });
});

test("viewport keeps a focused range visible when it fits", () => {
	const viewport = calculateViewport(30, 8, 14, 16);
	assert.equal(viewport.hasAbove, true);
	assert.equal(viewport.hasBelow, true);
	assert.ok(viewport.start <= 14);
	assert.ok(viewport.end > 16);
	assert.ok(viewport.end - viewport.start <= 6); // two visible overflow indicators
});

test("viewport recomputes focus visibility after resize", () => {
	const short = calculateViewport(30, 5, 20);
	const tall = calculateViewport(30, 12, 20);
	assert.ok(short.start <= 20 && short.end > 20);
	assert.ok(tall.start <= 20 && tall.end > 20);
	assert.ok(tall.end - tall.start > short.end - short.start);
});

test("viewport has a positive body and bounded output for tiny heights", () => {
	for (const height of [-3, 0, 1]) {
		const viewport = calculateViewport(10, height, 9);
		assert.ok(viewport.end - viewport.start >= 1);
		assert.ok(viewport.end - viewport.start + Number(viewport.hasAbove) + Number(viewport.hasBelow) <= 1);
	}
});

test("sticky footer reserves one row while retaining the focused body row", () => {
	const viewport = calculateStickyFooterViewport(20, 6, 19);
	assert.equal(viewport.footerVisible, true);
	assert.ok(viewport.body.start <= 19 && viewport.body.end > 19);
	assert.ok(viewport.body.end - viewport.body.start + Number(viewport.body.hasAbove) + Number(viewport.body.hasBelow) + 1 <= 6);
});

test("sticky footer falls back to the focused body row at one-row heights", () => {
	for (const height of [-3, 0, 1]) {
		const viewport = calculateStickyFooterViewport(10, height, 9);
		assert.equal(viewport.footerVisible, false);
		assert.ok(viewport.body.start <= 9 && viewport.body.end > 9);
		assert.ok(viewport.body.end - viewport.body.start + Number(viewport.body.hasAbove) + Number(viewport.body.hasBelow) <= 1);
	}
});

test("viewport calculations preserve bounded focused output across totals, heights, and focus positions", () => {
	for (let total = 0; total <= 25; total++) {
		for (let height = -2; height <= 20; height++) {
			for (let focus = -3; focus <= total + 3; focus++) {
				const viewport = calculateViewport(total, height, focus);
				const cap = Math.max(1, height);
				assert.ok(viewport.start >= 0 && viewport.start <= viewport.end && viewport.end <= total);
				assert.ok(viewport.end - viewport.start + Number(viewport.hasAbove) + Number(viewport.hasBelow) <= cap);
				if (total === 0) {
					assert.deepEqual(viewport, { start: 0, end: 0, hasAbove: false, hasBelow: false });
				} else {
					const clampedFocus = Math.max(0, Math.min(total - 1, focus));
					assert.ok(viewport.start <= clampedFocus && viewport.end > clampedFocus);
					if (viewport.hasAbove) assert.ok(viewport.start > 0);
					if (viewport.hasBelow) assert.ok(viewport.end < total);
				}

				const sticky = calculateStickyFooterViewport(total, height, focus);
				assert.equal(sticky.footerVisible, cap >= 2);
				assert.ok(sticky.body.end - sticky.body.start + Number(sticky.body.hasAbove) + Number(sticky.body.hasBelow) + Number(sticky.footerVisible) <= cap);
				if (total > 0) {
					const clampedFocus = Math.max(0, Math.min(total - 1, focus));
					assert.ok(sticky.body.start <= clampedFocus && sticky.body.end > clampedFocus);
				}
			}
		}
	}
});

test("terminal rows 0 through 2 use the one-row body fallback", () => {
	for (const rows of [0, 1, 2]) {
		const viewport = calculateStickyFooterViewport(10, Math.max(1, rows - 2), 9);
		assert.equal(viewport.footerVisible, false);
		assert.ok(viewport.body.start <= 9 && viewport.body.end > 9);
	}
});

test("viewport indicators are visible and width-safe", () => {
	assert.equal(viewportIndicator("up", 3, 1), "↑");
	assert.equal(viewportIndicator("down", 12, 80), "↓ 12 more");
});
