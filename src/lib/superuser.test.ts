import { describe, expect, test } from 'vitest';
import { decideSuperuser } from './superuser.ts';

const env = { email: 'env@example.com', password: 'env-password' };
const flags = { email: 'flag@example.com', password: 'flag-password' };

describe('decideSuperuser', () => {
	test('flags win over the environment', () => {
		expect(decideSuperuser(flags, env, true)).toEqual({
			kind: 'use',
			credentials: { email: 'flag@example.com', password: 'flag-password' },
			reused: false
		});
	});

	test('reuses the credentials already in the environment', () => {
		expect(decideSuperuser({}, env, true)).toEqual({
			kind: 'use',
			credentials: env,
			reused: true
		});
	});

	test('prompts for the half nothing supplied, prefilling the other', () => {
		expect(decideSuperuser({ email: 'flag@example.com' }, {}, true)).toEqual({
			kind: 'prompt',
			known: { email: 'flag@example.com' }
		});
		expect(decideSuperuser({}, { password: 'env-password' }, true)).toEqual({
			kind: 'prompt',
			known: { password: 'env-password' }
		});
	});

	test('names only the flags still missing when there is no terminal', () => {
		expect(decideSuperuser({}, {}, false)).toEqual({
			kind: 'error',
			message:
				'Pass --email and --password for the PocketBase admin user. There is no terminal to ask on.'
		});
		expect(decideSuperuser({ email: 'flag@example.com' }, {}, false)).toEqual({
			kind: 'error',
			message: 'Pass --password for the PocketBase admin user. There is no terminal to ask on.'
		});
	});

	// A flag repeating what `.env` already says is still an explicit choice, but
	// it changes nothing, so it must not be reported as one.
	test('a flag matching the environment is not a reuse', () => {
		const decision = decideSuperuser({ email: env.email }, env, true);
		expect(decision).toEqual({ kind: 'use', credentials: env, reused: false });
	});
});
