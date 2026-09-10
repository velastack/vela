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
	test('slugs a branch into a preview tag', () => {
		expect(branchToEnvTag('feature/auth')).toBe('preview--feature-auth');
		expect(branchToEnvTag('fix/login-form-copy')).toBe('preview--fix-login-form-copy');
	});
});

describe('releaseId', () => {
	test('is filename safe and sorts by time', () => {
		const first = releaseId(new Date('2026-08-26T15:32:01.000Z'));
		const second = releaseId(new Date('2026-08-26T16:14:22.000Z'));
		expect(first).toBe('20260826T153201Z');
		expect(first < second).toBe(true);
		expect(first).toMatch(/^[0-9TZ]+$/);
	});
});
