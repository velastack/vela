import { describe, expect, test } from 'vitest';
import { destroyDecision, type DestroyRequest } from './destroy-guard.ts';

const base: DestroyRequest = {
	appName: 'velastack',
	envTag: 'preview--feature-x',
	purge: false,
	yes: false,
	interactive: true
};

describe('destroyDecision', () => {
	describe('a preview or named environment', () => {
		test('--yes proceeds', () => {
			expect(destroyDecision({ ...base, yes: true })).toEqual({ kind: 'proceed' });
			expect(destroyDecision({ ...base, envTag: 'staging', yes: true })).toEqual({
				kind: 'proceed'
			});
		});

		test('asks on a terminal without --yes', () => {
			expect(destroyDecision(base)).toEqual({ kind: 'prompt', byName: false });
		});

		test('refuses off a terminal without --yes', () => {
			const decision = destroyDecision({ ...base, interactive: false });
			expect(decision.kind).toBe('refuse');
			expect(decision).toMatchObject({ message: expect.stringContaining('--yes') });
		});
	});

	describe('production', () => {
		const prod = { ...base, envTag: 'prod' };

		test('--yes alone is refused, even on a terminal', () => {
			for (const interactive of [true, false]) {
				const decision = destroyDecision({ ...prod, yes: true, interactive });
				expect(decision.kind).toBe('refuse');
				expect(decision).toMatchObject({
					message: expect.stringContaining('--confirm velastack')
				});
			}
		});

		test('asks for the name on a terminal', () => {
			expect(destroyDecision(prod)).toEqual({ kind: 'prompt', byName: true });
		});

		test('refuses off a terminal without --confirm', () => {
			const decision = destroyDecision({ ...prod, interactive: false });
			expect(decision.kind).toBe('refuse');
			expect(decision).toMatchObject({ message: expect.stringContaining('--confirm velastack') });
		});

		test('--confirm with the app name proceeds, with or without --yes', () => {
			expect(destroyDecision({ ...prod, confirm: 'velastack', interactive: false })).toEqual({
				kind: 'proceed'
			});
			expect(destroyDecision({ ...prod, confirm: 'velastack', yes: true })).toEqual({
				kind: 'proceed'
			});
		});

		test('--confirm with the wrong name is refused', () => {
			const decision = destroyDecision({ ...prod, confirm: 'velabase', yes: true });
			expect(decision.kind).toBe('refuse');
			expect(decision).toMatchObject({ message: expect.stringContaining('velabase') });
		});

		test('`production` spelled out counts as production', () => {
			expect(destroyDecision({ ...base, envTag: 'production', yes: true }).kind).toBe('refuse');
		});
	});

	describe('--purge', () => {
		const staging = { ...base, envTag: 'staging', purge: true };

		test('needs the name like production does on a named environment', () => {
			expect(destroyDecision(staging)).toEqual({ kind: 'prompt', byName: true });
			expect(destroyDecision({ ...staging, yes: true }).kind).toBe('refuse');
			expect(destroyDecision({ ...staging, confirm: 'velastack' })).toEqual({ kind: 'proceed' });
		});

		test('names the database in its refusal', () => {
			const decision = destroyDecision({ ...staging, yes: true });
			expect(decision).toMatchObject({ message: expect.stringContaining('its database') });
		});

		test('a preview is disposable: --yes is enough to purge it', () => {
			expect(destroyDecision({ ...base, purge: true, yes: true })).toEqual({ kind: 'proceed' });
			expect(destroyDecision({ ...base, purge: true })).toEqual({ kind: 'prompt', byName: false });
		});
	});
});
