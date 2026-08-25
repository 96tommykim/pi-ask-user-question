/**
 * Pure viewport calculations for the custom question dialog.
 *
 * `height` includes the overflow indicator rows. The returned content range is
 * half-open and always has room for the focused range when it fits.
 */
export interface Viewport {
	start: number;
	end: number;
	hasAbove: boolean;
	hasBelow: boolean;
}

export function calculateViewport(totalLines: number, height: number, focusStart: number, focusEnd = focusStart): Viewport {
	const total = Math.max(0, Math.floor(totalLines));
	const viewportHeight = Math.max(1, Math.floor(height));
	if (total === 0) return { start: 0, end: 0, hasAbove: false, hasBelow: false };

	const firstFocus = Math.max(0, Math.min(total - 1, Math.floor(focusStart)));
	const lastFocus = Math.max(firstFocus, Math.min(total - 1, Math.floor(focusEnd)));
	// Preserve question and tab context until the focus actually falls below the
	// available content area; starting at the focus would scroll too eagerly.
	let start = 0;
	let indicatorCount = 0;
	const maxIndicators = Math.max(0, viewportHeight - 1); // never displace the only body row

	// Indicators consume rows, which can change whether either indicator is
	// needed. It settles in at most a few iterations because there are only two.
	for (let iteration = 0; iteration < 4; iteration++) {
		const contentHeight = Math.max(1, viewportHeight - indicatorCount);
		if (firstFocus < start) start = firstFocus;
		if (lastFocus >= start + contentHeight) start = lastFocus - contentHeight + 1;
		start = Math.max(0, Math.min(Math.max(0, total - contentHeight), start));

		const end = Math.min(total, start + contentHeight);
		const aboveExists = start > 0;
		const belowExists = end < total;
		const nextIndicatorCount = Math.min(maxIndicators, Number(aboveExists) + Number(belowExists));
		if (nextIndicatorCount === indicatorCount) {
			// A one-row viewport cannot show an indicator without hiding the focus.
			// When only one indicator fits, prefer the direction of the larger hidden range.
			const hasAbove = nextIndicatorCount > 0 && aboveExists && (!belowExists || nextIndicatorCount > 1 || start >= total - end);
			const hasBelow = nextIndicatorCount > 0 && belowExists && (!aboveExists || nextIndicatorCount > 1 || !hasAbove);
			return { start, end, hasAbove, hasBelow };
		}
		indicatorCount = nextIndicatorCount;
	}

	const contentHeight = Math.max(1, viewportHeight - indicatorCount);
	start = Math.max(0, Math.min(Math.max(0, total - contentHeight), start));
	const end = Math.min(total, start + contentHeight);
	const aboveExists = start > 0;
	const belowExists = end < total;
	const hasAbove = indicatorCount > 0 && aboveExists && (!belowExists || indicatorCount > 1 || start >= total - end);
	const hasBelow = indicatorCount > 0 && belowExists && (!aboveExists || indicatorCount > 1 || !hasAbove);
	return { start, end, hasAbove, hasBelow };
}

/** A single-line, width-safe overflow indicator for a viewport edge. */
export function viewportIndicator(direction: "up" | "down", hiddenLines: number, width: number): string {
	const marker = direction === "up" ? "↑" : "↓";
	const available = Math.max(1, Math.floor(width));
	const text = `${marker} ${Math.max(1, Math.floor(hiddenLines))} more`;
	return text.slice(0, available);
}
