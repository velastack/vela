import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runPattern } from './pattern-runner.ts';
import { KitVersionError } from './kit-version.ts';

let tmp: string;
let cwd: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-pattern-runner-'));
	fs.mkdirSync(path.join(tmp, 'src', 'routes'), { recursive: true });
	cwd = process.cwd();
	process.chdir(tmp);
});

afterEach(() => {
	process.chdir(cwd);
	fs.rmSync(tmp, { recursive: true, force: true });
});

const report = { task: { title: 't', success: 's', error: 'e' } };

// enable, generate, disable, destroy and `enable cms` all run through here.
test('refuses a SvelteKit 2 project before the pattern writes anything', async () => {
	fs.writeFileSync(
		path.join(tmp, 'package.json'),
		JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.70.3' } })
	);
	const before = fs.readdirSync(tmp, { recursive: true });
	await expect(runPattern('enable-payments', [], {}, report)).rejects.toBeInstanceOf(
		KitVersionError
	);
	expect(fs.readdirSync(tmp, { recursive: true })).toEqual(before);
});
