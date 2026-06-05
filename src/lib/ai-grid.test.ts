import { describe, it, expect } from 'vitest';
import { renderGrid } from './ai-grid.ts';
import type { FormLayout } from './ai-client.ts';

const sampleLayout: FormLayout = {
	rows: [
		{
			cols: [
				{ span: 6, field: 'first_name' },
				{ span: 6, field: 'last_name' }
			]
		},
		{ cols: [{ span: 12, field: 'email' }] },
		{
			cols: [
				{ span: 6, field: 'city' },
				{ span: 3, field: 'state' },
				{ span: 3, field: 'zip' }
			]
		}
	]
};

describe('renderGrid', () => {
	it('renders an ASCII box for a normal-width terminal', () => {
		const out = renderGrid(sampleLayout, 80);
		expect(out).toContain('first_name');
		expect(out).toContain('last_name');
		expect(out).toContain('email');
		expect(out).toContain('city');
		expect(out).toContain('state');
		expect(out).toContain('zip');
		expect(out).toContain('┌');
		expect(out).toContain('└');
	});

	it('falls back to a list view on narrow terminals', () => {
		const out = renderGrid(sampleLayout, 40);
		expect(out).toContain('row 1: first_name(6) | last_name(6)');
		expect(out).toContain('row 2: email(12)');
		expect(out).toContain('row 3: city(6) | state(3) | zip(3)');
		expect(out).not.toContain('┌');
	});

	it('handles a single full-width row', () => {
		const out = renderGrid({ rows: [{ cols: [{ span: 12, field: 'message' }] }] }, 80);
		expect(out).toContain('message');
		expect(out.startsWith('┌')).toBe(true);
		expect(out.trimEnd().endsWith('┘')).toBe(true);
	});
});
