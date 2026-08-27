import { describe, expect, test } from 'vitest';
import { branchToEnvTag, instanceId } from './instance.ts';
import { describeTarget, parseTarget, TargetError } from './target.ts';

describe('parseTarget', () => {
	test('falls back to what the command means without -t', () => {
		expect(parseTarget(undefined, 'local')).toEqual({ kind: 'local' });
		expect(parseTarget(undefined, 'production')).toEqual({
			kind: 'remote',
			name: 'production',
			envTag: 'prod'
		});
		expect(parseTarget('  ', 'local')).toEqual({ kind: 'local' });
	});

	test('reads production under either spelling', () => {
		for (const spelling of ['prod', 'production', 'Production', 'PROD']) {
			expect(parseTarget(spelling, 'local')).toMatchObject({ kind: 'remote', envTag: 'prod' });
		}
	});

	test('takes any name as a target, so staging needs no new concept', () => {
		expect(parseTarget('staging', 'production')).toEqual({
			kind: 'remote',
			name: 'staging',
			envTag: 'staging'
		});
	});

	test('never turns local into a remote environment', () => {
		// `normalizeEnvTag('local')` is perfectly valid and would deploy an
		// environment called "local" to a server, which is the opposite of intent.
		expect(parseTarget('local', 'production')).toEqual({ kind: 'local' });
	});
});

describe('parseTarget, preview', () => {
	test('carries the branch', () => {
		expect(parseTarget('preview:feature/maps', 'local')).toMatchObject({
			kind: 'preview',
			branch: 'feature/maps'
		});
		expect(parseTarget('preview', 'local')).toMatchObject({ kind: 'preview', branch: undefined });
	});

	test('keeps a branch on the same instance as branchToEnvTag', () => {
		// The colon has to be split off before normalization: `normalizeEnvTag`
		// would collapse it to a single dash and name a different instance.
		const target = parseTarget('preview:feature/maps', 'local');
		expect(target.kind).toBe('preview');
		if (target.kind !== 'preview') return;

		expect(target.envTag).toBe(branchToEnvTag('feature/maps'));
		expect(instanceId('abc123', target.envTag)).toBe('abc123--preview--feature-maps');
	});

	test('keeps a nested branch intact', () => {
		const target = parseTarget('preview:nathan/feature/maps', 'local');
		expect(target).toMatchObject({ kind: 'preview', branch: 'nathan/feature/maps' });
	});
});

describe('parseTarget, the server guard', () => {
	test('refuses what -t used to mean', () => {
		for (const server of ['root@1.2.3.4', 'root@example.com', '146.190.139.138', 'example.com']) {
			expect(() => parseTarget(server, 'production')).toThrow(TargetError);
		}
	});

	test('says why, and where the server goes instead', () => {
		expect(() => parseTarget('root@146.190.139.138', 'production')).toThrow(/--server/);
	});

	test('refuses a colon on anything but preview', () => {
		expect(() => parseTarget('staging:main', 'production')).toThrow(TargetError);
	});
});

describe('describeTarget', () => {
	test('reads back the way it was typed', () => {
		expect(describeTarget(parseTarget('local', 'local'))).toBe('local');
		expect(describeTarget(parseTarget('staging', 'local'))).toBe('staging');
		expect(describeTarget(parseTarget('preview:fix/login', 'local'))).toBe('preview:fix/login');
		expect(describeTarget(parseTarget(undefined, 'production'))).toBe('production');
	});
});
