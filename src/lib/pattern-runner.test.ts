import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { listMigrations, runPattern, splitCreated } from './pattern-runner.ts';
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

describe('splitCreated', () => {
	const ok = (p: string) => ({ path: p, status: 'success' as const });

	test('lists a migration PocketBase wrote during the run as created', () => {
		fs.mkdirSync(path.join(tmp, 'migrations'));
		fs.writeFileSync(path.join(tmp, 'migrations', '100_created_posts.js'), '');
		const before = listMigrations(tmp);
		const { created, modified } = splitCreated(
			[ok('src/lib/server/whatsapp.ts')],
			[
				ok('migrations/200_updated_users.js'),
				ok('migrations/100_created_posts.js'),
				ok('src/routes/(public)/(auth)/login/+page.svelte'),
				{ path: 'migrations/300_updated_users.js', status: 'failed' as const }
			],
			tmp,
			before
		);
		expect(created.map((f) => f.path)).toEqual([
			'src/lib/server/whatsapp.ts',
			'migrations/200_updated_users.js'
		]);
		// one that was already there, or a file outside migrations/, really was modified
		expect(modified.map((f) => f.path)).toEqual([
			'migrations/100_created_posts.js',
			'src/routes/(public)/(auth)/login/+page.svelte'
		]);
	});

	test('takes absolute paths, and a project without migrations/', () => {
		const migration = path.join(tmp, 'migrations', '200_created_teams.js');
		const { created, modified } = splitCreated([], [ok(migration)], tmp, listMigrations(tmp));
		expect(created.map((f) => f.path)).toEqual([migration]);
		expect(modified).toEqual([]);
	});
});
