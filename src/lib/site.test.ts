import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SITE_FILE, isLocalUrl, readSite } from './site.ts';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-site-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function writeSite(source: string): void {
	fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
	fs.writeFileSync(path.join(root, SITE_FILE), source);
}

describe('readSite', () => {
	test('reads the name and url the templates write', async () => {
		writeSite(
			[
				'/** Site-wide metadata. */',
				'export const site = {',
				"\tname: 'Tom\\'s Cafe',",
				"\turl: 'https://example.com',",
				"\tcmsEndpoint: ''",
				'};'
			].join('\n')
		);
		expect(await readSite(root)).toEqual({ name: "Tom's Cafe", url: 'https://example.com' });
	});

	test('sees through `as const` and `satisfies`', async () => {
		writeSite("export const site = { name: `Acme`, url: 'https://acme.test' } as const;\n");
		expect(await readSite(root)).toEqual({ name: 'Acme', url: 'https://acme.test' });
	});

	test('leaves out values it would have to run code to know', async () => {
		writeSite(
			[
				"import { env } from '$env/dynamic/public';",
				"export const site = { name: env.PUBLIC_NAME, url: 'https://example.com' };"
			].join('\n')
		);
		expect(await readSite(root)).toEqual({ url: 'https://example.com' });
	});

	test('is null without the file or the object', async () => {
		expect(await readSite(root)).toBeNull();
		writeSite("export const name = 'Acme';\n");
		expect(await readSite(root)).toBeNull();
	});
});

describe('isLocalUrl', () => {
	test('is true for the address a new project starts with', () => {
		expect(isLocalUrl('http://localhost:5173')).toBe(true);
		expect(isLocalUrl('http://127.0.0.1:4173')).toBe(true);
	});

	test('is false for a real host or no URL at all', () => {
		expect(isLocalUrl('https://example.com')).toBe(false);
		expect(isLocalUrl('not a url')).toBe(false);
	});
});
