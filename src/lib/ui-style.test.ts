import { describe, expect, test } from 'vitest';
import { uiStyleReport } from './ui-style.ts';

describe('uiStyleReport', () => {
	test('reports the re-added components, files and font package', () => {
		const report = uiStyleReport({
			status: 'switched',
			style: 'nova',
			reinstalled: ['button', 'card'],
			filesModified: ['components.json', 'src/app.css', 'package.json'],
			packages: ['@fontsource-variable/geist'],
			hints: ['src/app.css still imports @fontsource-variable/inter from the previous style.']
		});
		expect(report.summary).toBe('Switched to the nova style.');
		expect(report.nextSteps).toContain(
			'src/app.css still imports @fontsource-variable/inter from the previous style.'
		);
		expect(report.componentsAdded).toEqual(['button', 'card']);
		expect(report.filesModified).toEqual(['components.json', 'src/app.css', 'package.json']);
		expect(report.packagesInstalled).toEqual(['@fontsource-variable/geist']);
		expect(report.nextSteps?.some((s) => s.includes('git diff'))).toBe(true);
	});

	test('skips the git diff hint when nothing was re-added', () => {
		const report = uiStyleReport({
			status: 'switched',
			style: 'rhea',
			reinstalled: [],
			filesModified: ['components.json'],
			packages: [],
			hints: []
		});
		expect(report.nextSteps?.some((s) => s.includes('git diff'))).toBe(false);
	});
});
