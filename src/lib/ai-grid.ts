import type { FormLayout } from './ai-client.ts';

const TOTAL_COLS = 12;
const MIN_TERM_WIDTH = 60;

function pad(s: string, width: number): string {
	if (s.length >= width) return s.slice(0, width);
	return s + ' '.repeat(width - s.length);
}

function colWidths(layout: FormLayout, terminalWidth: number): number[][] {
	const innerWidth = Math.max(MIN_TERM_WIDTH, terminalWidth) - 2;
	return layout.rows.map((row) => {
		const cellWidths: number[] = [];
		let used = 0;
		for (let i = 0; i < row.cols.length; i++) {
			const col = row.cols[i]!;
			const isLast = i === row.cols.length - 1;
			const target = Math.round((innerWidth * col.span) / TOTAL_COLS);
			const w = isLast ? innerWidth - used : Math.max(target, col.field.length + 2);
			cellWidths.push(w);
			used += w;
		}
		return cellWidths;
	});
}

/**
 * Render a FormLayout as an ASCII grid. Falls back to a list view when
 * the terminal is narrower than MIN_TERM_WIDTH.
 */
export function renderGrid(layout: FormLayout, terminalWidth = process.stdout.columns ?? 80): string {
	if (terminalWidth < MIN_TERM_WIDTH) {
		return layout.rows
			.map(
				(row, i) =>
					`row ${i + 1}: ${row.cols.map((c) => `${c.field}(${c.span})`).join(' | ')}`
			)
			.join('\n');
	}

	const widths = colWidths(layout, terminalWidth);
	const lines: string[] = [];

	for (let r = 0; r < layout.rows.length; r++) {
		const row = layout.rows[r]!;
		const w = widths[r]!;

		const top = r === 0 ? '┌' + w.map((width) => '─'.repeat(width)).join('┬') + '┐' : '';
		if (top) lines.push(top);

		const content = '│' + row.cols.map((c, i) => ' ' + pad(c.field, w[i]! - 1)).join('│') + '│';
		lines.push(content);

		const isLast = r === layout.rows.length - 1;
		if (isLast) {
			lines.push('└' + w.map((width) => '─'.repeat(width)).join('┴') + '┘');
		} else {
			const nextW = widths[r + 1]!;
			lines.push(buildSeparator(w, nextW));
		}
	}

	return lines.join('\n');
}

function buildSeparator(curr: number[], next: number[]): string {
	const currBoundaries = new Set<number>();
	let pos = 0;
	for (let i = 0; i < curr.length - 1; i++) {
		pos += curr[i]!;
		currBoundaries.add(pos);
	}

	const nextBoundaries = new Set<number>();
	pos = 0;
	for (let i = 0; i < next.length - 1; i++) {
		pos += next[i]!;
		nextBoundaries.add(pos);
	}

	const total = curr.reduce((a, b) => a + b, 0);
	let line = '├';
	for (let i = 0; i < total; i++) {
		const inCurr = currBoundaries.has(i);
		const inNext = nextBoundaries.has(i);
		if (inCurr && inNext) line += '┼';
		else if (inCurr) line += '┴';
		else if (inNext) line += '┬';
		else line += '─';
	}
	line += '┤';
	return line;
}
