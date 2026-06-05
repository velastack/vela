import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { isVanillaRoutes } from './scaffold-detect.ts';

describe('isVanillaRoutes', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-scaffold-test-'));
		fs.mkdirSync(path.join(tmpDir, 'src', 'routes'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('returns true when +page.svelte contains the welcome marker', () => {
		fs.writeFileSync(
			path.join(tmpDir, 'src', 'routes', '+page.svelte'),
			'<h1>Welcome to SvelteKit</h1>\n<p>Visit the docs.</p>\n'
		);
		expect(isVanillaRoutes(tmpDir)).toBe(true);
	});

	test('returns false when the marker has been edited out', () => {
		fs.writeFileSync(
			path.join(tmpDir, 'src', 'routes', '+page.svelte'),
			'<h1>My custom page</h1>\n'
		);
		expect(isVanillaRoutes(tmpDir)).toBe(false);
	});

	test('returns false when +page.svelte does not exist', () => {
		expect(isVanillaRoutes(tmpDir)).toBe(false);
	});
});
