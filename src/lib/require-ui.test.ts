import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { assertShadcn } from './require-ui.ts';

describe('assertShadcn', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-require-ui-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const writePackage = (devDependencies: Record<string, string>) =>
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies }));

	test('refuses a project `sv create` made, naming the command and the way in', () => {
		writePackage({ '@sveltejs/kit': '^2.0.0' });
		expect(() => assertShadcn('vela enable blog', root)).toThrow(
			/`vela enable blog` needs shadcn-svelte[\s\S]*Nothing was changed[\s\S]*shadcn-svelte@latest init/
		);
	});

	// components.json is what `shadcn-svelte add` reads; the package is what the
	// installed components import. Either one alone is not a working setup.
	test('refuses half a setup', () => {
		writePackage({ 'shadcn-svelte': '^1.7.0' });
		expect(() => assertShadcn('vela ui add', root)).toThrow();
	});

	test('passes a shadcn-svelte project', () => {
		writePackage({ 'shadcn-svelte': '^1.7.0' });
		fs.writeFileSync(path.join(root, 'components.json'), '{}');
		expect(() => assertShadcn('vela ui add', root)).not.toThrow();
	});
});
