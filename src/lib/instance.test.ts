import { describe, expect, test } from 'vitest';
import {
	INSTANCE_ID_RE,
	branchToEnvTag,
	instanceId,
	normalizeEnvTag,
	releaseId
} from './instance.ts';

describe('normalizeEnvTag', () => {
	test('defaults to prod', () => {
		expect(normalizeEnvTag(undefined)).toBe('prod');
		expect(normalizeEnvTag('')).toBe('prod');
		expect(normalizeEnvTag('production')).toBe('prod');
	});

	test('lowercases and replaces separators', () => {
		expect(normalizeEnvTag('Staging')).toBe('staging');
		expect(normalizeEnvTag('preview/feature-auth')).toBe('preview--feature-auth');
		expect(normalizeEnvTag('preview/feature/auth')).toBe('preview--feature--auth');
	});

	test('strips unsupported characters', () => {
		expect(normalizeEnvTag('pre view!')).toBe('pre-view');
		expect(normalizeEnvTag('--staging--')).toBe('staging');
	});

	test('rejects a tag with nothing usable in it', () => {
		expect(() => normalizeEnvTag('!!!')).toThrow();
	});
});

describe('instanceId', () => {
	test('production is the bare app id', () => {
		expect(instanceId('abc123')).toBe('abc123');
		expect(instanceId('abc123', 'prod')).toBe('abc123');
	});

	test('other environments are suffixed', () => {
		expect(instanceId('abc123', 'staging')).toBe('abc123--staging');
		expect(instanceId('abc123', 'preview/feature-auth')).toBe('abc123--preview--feature-auth');
	});

	test('every id matches the shape the server scripts check', () => {
		for (const id of [
			instanceId('zdyly4bg3wuwr5x'),
			instanceId('zdyly4bg3wuwr5x', 'staging'),
			instanceId('velabase-e7a7079c', 'prod'),
			instanceId('abc123', branchToEnvTag('feature/auth')),
			instanceId('abc123', branchToEnvTag('Fix Login Form (#12)'))
		]) {
			expect(id).toMatch(INSTANCE_ID_RE);
		}
		// The same regex, so the shell side is auditable against this one.
		expect(INSTANCE_ID_RE.source).toBe('^[a-z0-9]+(-{1,2}[a-z0-9]+)*$');
	});
});

describe('branchToEnvTag', () => {
	test('a branch the slug spells exactly keeps its name', () => {
		expect(branchToEnvTag('fix-copy')).toBe('preview--fix-copy');
		expect(branchToEnvTag('dependabot')).toBe('preview--dependabot');
	});

	test('a lossy slug carries a hash of the full branch name', () => {
		expect(branchToEnvTag('feature/auth')).toMatch(/^preview--feature-auth-[0-9a-f]{6}$/);
		expect(branchToEnvTag('Fix Login Form (#12)')).toMatch(
			/^preview--fix-login-form-12-[0-9a-f]{6}$/
		);
	});

	test('branches that fold to one slug get different tags', () => {
		const tags = ['feature/x', 'feature-x', 'feature_x', 'Feature-X'].map(branchToEnvTag);
		expect(new Set(tags).size).toBe(tags.length);
		expect(tags[1]).toBe('preview--feature-x');
	});

	test('long branches are cut to the limit and still distinct', () => {
		const a = branchToEnvTag('dependabot/npm_and_yarn/minor-and-patch-3b9526d1a6');
		const b = branchToEnvTag('dependabot/npm_and_yarn/minor-and-patch-3b9526d1a7');
		expect(a).not.toBe(b);
		for (const tag of [a, b]) {
			expect(tag.slice('preview--'.length).length).toBeLessThanOrEqual(48);
			expect(tag).toMatch(/^preview--[a-z0-9-]+-[0-9a-f]{6}$/);
			expect(tag).not.toMatch(/--[0-9a-f]{6}$/);
		}
	});

	test('is stable', () => {
		expect(branchToEnvTag('feature/auth')).toBe(branchToEnvTag('feature/auth'));
	});
});

describe('releaseId', () => {
	test('is filename safe and sorts by time', () => {
		const first = releaseId(new Date('2026-08-26T15:32:01.000Z'), 'ffff');
		const second = releaseId(new Date('2026-08-26T16:14:22.000Z'), '0000');
		expect(first).toBe('20260826T153201Z-ffff');
		expect(first < second).toBe(true);
		expect(first).toMatch(/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/);
	});

	test('two ids for one second differ, and both sort after the bare stamp', () => {
		const at = new Date('2026-08-26T15:32:01.500Z');
		const a = releaseId(at);
		const b = releaseId(at);
		expect(a).not.toBe(b);
		expect(a > '20260826T153201Z').toBe(true);
		expect(b > '20260826T153201Z').toBe(true);
	});
});
