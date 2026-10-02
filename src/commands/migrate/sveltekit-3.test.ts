import { describe, expect, test } from 'vitest';
import { nextStepsFor } from './sveltekit-3.ts';
import type { Kit3MigrationResult } from '../../lib/kit3-migrate.ts';

function result(overrides: Partial<Kit3MigrationResult> = {}): Kit3MigrationResult {
	return {
		mode: 'repair',
		sv: { ran: false, failures: [], excluded: [], cleared: [], dropped: [] },
		fixups: [{ name: 'origin', changed: false, details: [], warnings: [] }],
		followUps: [],
		genericFollowUps: ['Servers need Node 22.17 or later.'],
		tasks: null,
		installed: true,
		formatted: [],
		...overrides
	};
}

describe('nextStepsFor', () => {
	test('a re-run that skipped sv and changed nothing: nothing to install, format or review', () => {
		expect(nextStepsFor(result({ installed: null }))).toEqual(['Nothing left to change.']);
	});

	test('...but what MIGRATION_TASKS.md still lists stays', () => {
		const steps = nextStepsFor(
			result({
				followUps: ['x'],
				tasks: { sections: [], filesToReview: 0, markerComments: 2 }
			})
		);
		expect(steps).toEqual([
			'Nothing left to change.',
			'Work through MIGRATION_TASKS.md, then delete it.',
			'Search the code for `@migration-task` and resolve each comment.'
		]);
	});

	test('sv skipped but vela changed something: install without blaming sv, then review', () => {
		const steps = nextStepsFor(
			result({
				installed: null,
				fixups: [{ name: 'origin', changed: true, details: ['moved'], warnings: [] }]
			})
		);
		expect(steps).toContain(
			'Install dependencies (`npm install`), then format what changed (`npx prettier --write .`).'
		);
		expect(steps.at(-1)).toBe('Review the diff and commit it.');
	});

	test('sv ran without an install: it could not format', () => {
		const steps = nextStepsFor(
			result({
				mode: 'migrate',
				installed: null,
				sv: { ran: true, failures: [], excluded: [], cleared: [], dropped: [] }
			})
		);
		expect(steps[0]).toMatch(/sv could not format without node_modules/);
		expect(steps).toContain('Servers need Node 22.17 or later.');
		expect(steps).not.toContain('Nothing left to change.');
	});
});
