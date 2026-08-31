import { describe, expect, test } from 'vitest';
import { REQUIRED_VITE_MAJOR, viteVersionError } from './vite.ts';

describe('viteVersionError', () => {
	test('accepts the required major and anything newer', () => {
		expect(viteVersionError('8.0.0')).toBeNull();
		expect(viteVersionError('8.2.2')).toBeNull();
		expect(viteVersionError('9.0.0')).toBeNull();
	});

	test('rejects an older major, naming the coupled plugin bump', () => {
		const error = viteVersionError('7.3.2');
		expect(error).toContain('vite 7.3.2');
		expect(error).toContain(`vite ${REQUIRED_VITE_MAJOR} or newer`);
		expect(error).toContain('@sveltejs/vite-plugin-svelte@^7');
	});

	test('rejects every major below the requirement', () => {
		for (const version of ['5.4.0', '6.3.5', '7.0.0']) {
			expect(viteVersionError(version)).not.toBeNull();
		}
	});

	test('accepts a prerelease of the required major', () => {
		expect(viteVersionError('8.0.0-beta.7')).toBeNull();
	});

	test('stays out of the way when the version is unreadable', () => {
		// Better to let vite fail on its own terms than to block a run over a
		// string we simply could not parse.
		expect(viteVersionError('')).toBeNull();
		expect(viteVersionError('unknown')).toBeNull();
	});
});
