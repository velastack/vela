import { describe, expect, test } from 'vitest';
import { uiListReport } from './ui-list.ts';

describe('uiListReport', () => {
	test('lists installed, vela and registry ui components', () => {
		const report = uiListReport({
			style: 'vega',
			installed: ['button', 'data-table', 'navbar'],
			custom: ['cells', 'data-table', 'multiselect'],
			registry: [
				{ name: 'card', type: 'registry:ui' },
				{ name: 'button', type: 'registry:ui' },
				{ name: 'dashboard-01', type: 'registry:block' },
				{ name: 'font-geist', type: 'registry:font' }
			]
		});
		expect(report.summary).toBe('UI components for the vega style.');
		expect(report.sections).toEqual([
			{ label: 'Installed (3)', items: ['button', 'data-table', 'navbar'] },
			{ label: 'Vela components', items: ['cells', 'data-table (installed)', 'multiselect'] },
			{ label: 'shadcn-svelte vega (2)', items: ['button', 'card'] }
		]);
	});

	test('drops the registry section when it could not be read', () => {
		const report = uiListReport({
			style: 'nova',
			installed: [],
			custom: ['data-table'],
			registry: [],
			registryUnavailable: 'Could not read the shadcn-svelte registry at https://x: HTTP 503'
		});
		expect(report.sections?.map((s) => s.label)).toEqual(['Installed (0)', 'Vela components']);
	});
});
