import { describe, expect, test } from 'vitest';
import { uiAddReport } from './ui-add.ts';

describe('uiAddReport', () => {
	test('lists what was installed and which packages came with it', () => {
		const report = uiAddReport(['data-table', 'card'], {
			installed: ['card', 'data-table'],
			skipped: [],
			packages: ['@tanstack/table-core@^8.21.3']
		});
		expect(report.summary).toBe('Added 2 UI component(s).');
		expect(report.componentsAdded).toEqual(['card', 'data-table']);
		expect(report.packagesInstalled).toEqual(['@tanstack/table-core@^8.21.3']);
		expect(report.sections).toBeUndefined();
		expect(report.nextSteps?.some((s) => s.includes('--overwrite'))).toBe(false);
	});

	test('keeps skipped components out of "added" and explains how to replace them', () => {
		const report = uiAddReport(['button', 'badge'], {
			installed: ['badge'],
			skipped: ['button'],
			packages: []
		});
		expect(report.componentsAdded).toEqual(['badge']);
		expect(report.sections).toEqual([
			{ label: 'Already present (pass --overwrite to replace)', items: ['button'] }
		]);
		expect(report.nextSteps).toContain(
			'Re-add an existing component with: vela ui add --overwrite button'
		);
	});

	test('says everything was present instead of "Added 0"', () => {
		const report = uiAddReport(['button', 'button', 'card'], {
			installed: [],
			skipped: ['button', 'card'],
			packages: []
		});
		expect(report.summary).toBe('All 2 requested component(s) are already present.');
		expect(report.componentsAdded).toEqual([]);
	});
});
