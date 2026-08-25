import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateViewport, viewportIndicator } from "./viewport.ts";

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

test("viewport indicators are visible and width-safe", () => {
	assert.equal(viewportIndicator("up", 3, 1), "↑");
	assert.equal(viewportIndicator("down", 12, 80), "↓ 12 more");
});
