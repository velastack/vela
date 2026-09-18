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
	test('a bare SvelteKit project has none of the vela helpers', () => {
		writePackageJson({ '@sveltejs/kit': '^2.0.0' });
		expect(detectFormInput(tmp)).toEqual({ flash: false, serverTests: false });
	});

	test('a vela project has flash messages and server tests', () => {
		writePackageJson({ 'sveltekit-flash-message': '^2.4.6', supertest: '^7.2.2' });
		expect(detectFormInput(tmp)).toEqual({ flash: true, serverTests: true });
	});
});

describe('resolveFormInput', () => {
	test('leaves ui to the detected feature when --ui is not given', () => {
		writePackageJson({});
		expect(resolveFormInput(tmp, 'plain')).toEqual({ flash: false, serverTests: false });
	});

	test('--ui plain overrides detection but keeps the detected helpers', () => {
		writePackageJson({ 'sveltekit-flash-message': '^2.4.6' });
		expect(resolveFormInput(tmp, 'shadcn', 'plain')).toEqual({
			ui: 'plain',
			flash: true,
			serverTests: false
		});
	});

	test('--ui shadcn is refused where shadcn-svelte is not set up', () => {
		writePackageJson({});
		expect(() => resolveFormInput(tmp, 'plain', 'shadcn')).toThrow('vela bless');
	});

	test('rejects an unknown value', () => {
		writePackageJson({});
		expect(() => resolveFormInput(tmp, 'plain', 'bootstrap')).toThrow('Unknown --ui');
	});
});
