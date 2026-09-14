import { describe, expect, test } from 'vitest';
import type { Provider } from '@velastack/patterns';
import {
	capabilityName,
	checkProviderInput,
	decideProvider,
	missingEnvKeys,
	providerFlagInArgv,
	unknownProviderMessage
} from './providers.ts';

const PROVIDERS: Provider[] = [
	{
		id: 'plausible',
		label: 'Plausible',
		env: [{ key: 'PUBLIC_PLAUSIBLE_DOMAIN', label: 'Domain' }]
	},
	{ id: 'google', label: 'Google Analytics' },
	{
		id: 'posthog',
		label: 'PostHog',
		env: [
			{ key: 'PUBLIC_POSTHOG_KEY', label: 'Key' },
			{ key: 'PUBLIC_POSTHOG_HOST', label: 'Host', default: 'https://us.i.posthog.com' }
		]
	}
];

const analytics = { title: 'Enable analytics', providers: PROVIDERS };
const auth = { title: 'Enable authentication' };

describe('capabilityName', () => {
	test('strips the enable- prefix', () => {
		expect(capabilityName('enable-analytics')).toBe('analytics');
	});
});

describe('decideProvider', () => {
	test('uses a known --provider without prompting', () => {
		const decision = decideProvider({
			patternName: 'analytics',
			providers: PROVIDERS,
			flagValue: 'google',
			interactive: false
		});
		expect(decision).toEqual({ kind: 'use', provider: PROVIDERS[1] });
	});

	test('rejects an unknown --provider with the list of known ones', () => {
		const decision = decideProvider({
			patternName: 'analytics',
			providers: PROVIDERS,
			flagValue: 'foo',
			interactive: true
		});
		expect(decision).toEqual({
			kind: 'error',
			message: unknownProviderMessage('analytics', 'foo', PROVIDERS)
		});
		if (decision.kind === 'error') {
			expect(decision.message).toBe(
				'Unknown provider "foo" for analytics.\n\nAvailable providers:\n  plausible\n  google\n  posthog'
			);
		}
	});

	test('prompts on a terminal when no flag is given', () => {
		expect(
			decideProvider({ patternName: 'analytics', providers: PROVIDERS, interactive: true })
		).toEqual({ kind: 'prompt' });
	});

	test('names the flag when there is no terminal and no flag', () => {
		const decision = decideProvider({
			patternName: 'analytics',
			providers: PROVIDERS,
			interactive: false
		});
		expect(decision.kind).toBe('error');
		if (decision.kind === 'error') {
			expect(decision.message).toContain('--provider <plausible|google|posthog>');
			expect(decision.message).toContain('no terminal');
		}
	});
});

describe('providerFlagInArgv', () => {
	test('spots both spellings', () => {
		expect(providerFlagInArgv(['--provider', 'x'])).toBe(true);
		expect(providerFlagInArgv(['--other', '--provider=x'])).toBe(true);
	});

	test('ignores other flags', () => {
		expect(providerFlagInArgv(['--providers', '--endpoint', 'x'])).toBe(false);
		expect(providerFlagInArgv([])).toBe(false);
	});
});

describe('checkProviderInput', () => {
	test('accepts a providers pattern with input.provider', () => {
		expect(() => checkProviderInput(analytics, [], { provider: 'plausible' })).not.toThrow();
	});

	test('rejects a providers pattern without input.provider', () => {
		expect(() => checkProviderInput(analytics, [], {})).toThrow(
			'Enable analytics needs a provider. Pass --provider <plausible|google|posthog>.'
		);
		expect(() => checkProviderInput(analytics, [], { provider: '' })).toThrow('needs a provider');
	});

	test('rejects --provider left in argv for a pattern without providers', () => {
		expect(() => checkProviderInput(auth, ['--provider', 'x'], {})).toThrow(
			'Enable authentication does not support --provider.'
		);
		expect(() => checkProviderInput(auth, ['--provider=x'], {})).toThrow(
			'does not support --provider'
		);
	});

	test('leaves a pattern without providers alone otherwise', () => {
		expect(() => checkProviderInput(auth, ['--other'], {})).not.toThrow();
		// `enable payments` sends input.provider for a pattern that declares none.
		expect(() => checkProviderInput(auth, [], { provider: 'stripe' })).not.toThrow();
	});
});

describe('missingEnvKeys', () => {
	test('lists blank keys that have no default', () => {
		expect(
			missingEnvKeys(PROVIDERS[2], { PUBLIC_POSTHOG_KEY: '', PUBLIC_POSTHOG_HOST: '' })
		).toEqual(['PUBLIC_POSTHOG_KEY']);
		expect(missingEnvKeys(PROVIDERS[2], { PUBLIC_POSTHOG_KEY: 'phc_1' })).toEqual([]);
		expect(missingEnvKeys(PROVIDERS[0], {})).toEqual(['PUBLIC_PLAUSIBLE_DOMAIN']);
		expect(missingEnvKeys(PROVIDERS[1], {})).toEqual([]);
	});
});
