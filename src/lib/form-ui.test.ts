import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { detectFormInput, resolveFormInput } from './form-ui.ts';

let tmp: string;

function writePackageJson(devDependencies: Record<string, string>) {
	fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ devDependencies }));
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-form-ui-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('detectFormInput', () => {
	test('a bare SvelteKit project gets plain markup and none of the vela helpers', () => {
		writePackageJson({ '@sveltejs/kit': '^2.0.0' });
		expect(detectFormInput(tmp)).toEqual({ ui: 'plain', flash: false, serverTests: false });
	});

	test('a vela project gets shadcn markup, flash messages and server tests', () => {
		writePackageJson({
			'shadcn-svelte': '^1.6.0',
			'sveltekit-flash-message': '^2.4.6',
			supertest: '^7.2.2'
		});
		fs.writeFileSync(path.join(tmp, 'components.json'), JSON.stringify({ style: 'vega' }));
		expect(detectFormInput(tmp)).toEqual({ ui: 'shadcn', flash: true, serverTests: true });
	});

	test('components.json without the package is not enough', () => {
		writePackageJson({});
		fs.writeFileSync(path.join(tmp, 'components.json'), '{}');
		expect(detectFormInput(tmp).ui).toBe('plain');
	});
});

describe('resolveFormInput', () => {
	test('--ui plain overrides detection but keeps the detected helpers', () => {
		writePackageJson({ 'bits-ui': '^2.0.0', 'sveltekit-flash-message': '^2.4.6' });
		fs.writeFileSync(path.join(tmp, 'components.json'), '{}');
		expect(resolveFormInput(tmp, 'plain')).toEqual({
			ui: 'plain',
			flash: true,
			serverTests: false
		});
	});

	test('--ui shadcn is refused where shadcn-svelte is not set up', () => {
		writePackageJson({});
		expect(() => resolveFormInput(tmp, 'shadcn')).toThrow('vela bless');
	});

	test('rejects an unknown value', () => {
		writePackageJson({});
		expect(() => resolveFormInput(tmp, 'bootstrap')).toThrow('Unknown --ui');
	});
});
