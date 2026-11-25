import { describe, expect, test } from 'vitest';
import type { WorkflowRun } from '../../lib/workflows-api.ts';
import { describeOutcome } from './run.ts';

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
	return {
		id: 'run1',
		workflowName: 'send-digest',
		version: null,
		status: 'pending',
		attempts: 0,
		input: null,
		output: null,
		error: null,
		createdAt: '2026-11-24T10:00:00.000Z',
		updatedAt: '2026-11-24T10:00:00.000Z',
		availableAt: '2026-11-24T10:00:00.000Z',
		finishedAt: null,
		...overrides
	};
}

const local = { remote: false, targetName: 'local', flag: '', where: '', appRunning: false };
const production = {
	remote: true,
	targetName: 'production',
	flag: ' -t production',
	where: ' → production (root@203.0.113.10)',
	appRunning: true
};

describe('describeOutcome', () => {
	test('a local run with no app up is queued for `vela dev`', () => {
		const outcome = describeOutcome(run(), local, false);
		expect(outcome.level).toBe('success');
		expect(outcome.message).toContain('vela dev');
		expect(outcome.message).not.toContain('-t ');
	});

	test('a deployed run nothing claimed is a warning that names the target', () => {
		const outcome = describeOutcome(run(), production, true);
		expect(outcome.level).toBe('warn');
		expect(outcome.message).toContain('Nothing has picked it up yet');
		expect(outcome.message).toContain('vela status -t production');
		expect(outcome.message).not.toContain('vela dev');
	});

	test('a name the deployed app does not define says so, and how to stop the retries', () => {
		const error = { message: 'Workflow "send-digest" is not registered' };
		const outcome = describeOutcome(run({ error }), production, true);
		expect(outcome.level).toBe('warn');
		expect(outcome.message).toContain('does not define that workflow');
		expect(outcome.message).toContain('vela workflows cancel run1 -t production');
	});

	test('any other failed first attempt is reported as being retried', () => {
		const outcome = describeOutcome(run({ error: { message: 'boom' } }), production, true);
		expect(outcome.level).toBe('warn');
		expect(outcome.message).toContain('boom');
		expect(outcome.message).not.toContain('does not define');
	});

	test('a failed run is an error carrying its message', () => {
		const outcome = describeOutcome(
			run({ status: 'failed', error: { message: 'boom' } }),
			production,
			true
		);
		expect(outcome).toMatchObject({ level: 'error' });
		expect(outcome.message).toContain('boom');
	});

	test.each([
		['completed', 'completed as run'],
		['running', 'Started']
	] as const)('a %s run is a success', (status, text) => {
		const outcome = describeOutcome(run({ status }), production, true);
		expect(outcome.level).toBe('success');
		expect(outcome.message).toContain(text);
		expect(outcome.message).toContain('→ production');
	});

	test('--no-wait on a deployed target only says it was queued', () => {
		const outcome = describeOutcome(run(), production, false);
		expect(outcome.level).toBe('success');
		expect(outcome.message).toContain('vela workflows list -t production');
	});
});
