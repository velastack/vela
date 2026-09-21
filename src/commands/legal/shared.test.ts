import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { writeLegalPage } from './shared.ts';

const page = {
	html: '<section class="space-y-3"><h1 class="text-3xl font-semibold">Terms</h1><p class="text-base leading-7">Copy.</p></section>',
	title: 'Terms of Service',
	description: 'Terms of Service for {Acme} & "Co"'
};

describe('writeLegalPage', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-legal-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const writePackage = (dependencies: Record<string, string>) =>
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies }));
	const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

	test('a vela project keeps the Tailwind markup and gets the meta tags loader', () => {
		writePackage({ tailwindcss: '^4.0.0', 'svelte-meta-tags': '^4.0.0' });
		const dir = path.join('src', 'routes', '(public)', '(legal)', 'terms');

		expect(writeLegalPage(root, dir, page)).toEqual([
			path.join(dir, '+page.svelte'),
			path.join(dir, '+page.ts')
		]);
		expect(read(path.join(dir, '+page.svelte'))).toBe(page.html);
		expect(read(path.join(dir, '+page.ts'))).toContain("from 'svelte-meta-tags'");
	});

	test('a project with neither gets bare markup and a <svelte:head>, and no loader', () => {
		writePackage({});
		const dir = path.join('src', 'routes', 'terms');

		expect(writeLegalPage(root, dir, page)).toEqual([path.join(dir, '+page.svelte')]);
		const svelte = read(path.join(dir, '+page.svelte'));
		expect(svelte).not.toContain('class=');
		expect(svelte).toContain('<title>Terms of Service</title>');
		// Braces would open a Svelte expression; quotes would close the attribute.
		expect(svelte).toContain(
			'content="Terms of Service for &#123;Acme&#125; &amp; &quot;Co&quot;"'
		);
		expect(svelte).toContain('<section><h1>Terms</h1><p>Copy.</p></section>');
		expect(fs.existsSync(path.join(root, dir, '+page.ts'))).toBe(false);
	});
});
