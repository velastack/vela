import { beforeEach, describe, expect, test, vi } from 'vitest';

const runPattern = vi.fn();
vi.mock('../lib/pattern-runner.ts', () => ({
	runPattern: (...args: unknown[]) => runPattern(...args)
}));

// Imported on their own, so no parent program and none of its hooks (the
// backend gate) run: these only check which pattern each flag selects.
const { auth } = await import('./enable/auth.ts');
const { workflow } = await import('./generate/workflow.ts');
const { resource } = await import('./generate/resource.ts');
const { migration } = await import('./generate/migration.ts');

describe('pattern flags', () => {
	beforeEach(() => {
		runPattern.mockReset();
	});

	test('enable auth runs enable-auth', async () => {
		await auth.parseAsync([], { from: 'user' });
		expect(runPattern).toHaveBeenCalledOnce();
		expect(runPattern.mock.calls[0][0]).toBe('enable-auth');
	});

	test('enable auth --remote runs enable-auth-remote', async () => {
		await auth.parseAsync(['--remote'], { from: 'user' });
		expect(runPattern).toHaveBeenCalledOnce();
		expect(runPattern.mock.calls[0][0]).toBe('enable-auth-remote');
		// the flag is consumed, not forwarded to the pattern
		expect(runPattern.mock.calls[0][1]).toEqual([]);
	});

	test('generate workflow forwards --cron to the pattern', async () => {
		await workflow.parseAsync(['nightly', '--cron', '0 3 * * *'], { from: 'user' });
		expect(runPattern.mock.calls[0][0]).toBe('generate-workflow');
		expect(runPattern.mock.calls[0][1]).toEqual(['nightly', '--cron', '0 3 * * *']);
	});

	test('generate resource promises no pages and points at scaffold', async () => {
		expect(resource.description()).not.toMatch(/CRUD pages/);
		await resource.parseAsync(['bracket', 'name:text'], { from: 'user' });
		const steps: string[] = runPattern.mock.calls[0][3].nextSteps;
		expect(steps.join('\n')).not.toMatch(/\+page\.svelte|visit \//);
		expect(steps.join('\n')).toContain('vela generate scaffold bracket');
	});

	test('generate migration says the change is applied and names the schema', async () => {
		await migration.parseAsync(['songs', 'add', 'year:number'], { from: 'user' });
		const steps: string[] = runPattern.mock.calls[0][3].nextSteps;
		expect(steps.join('\n')).toContain('already applied to the local database');
		expect(steps.join('\n')).toContain('src/lib/schemas/');
		expect(steps.join('\n')).toContain('vela generate schema <model>');
		expect(steps.join('\n')).not.toMatch(/^Run `vela migrate up`/m);
	});
});
