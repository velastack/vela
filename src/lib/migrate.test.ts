import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	BLANK_MIGRATION,
	confirmMigrate,
	listMigrationFiles,
	migrationSlug,
	parseMigrateDownOutput,
	writeBlankMigration
} from './migrate.ts';

describe('migrationSlug', () => {
	test.each([
		['soty_rules_indexes', 'soty_rules_indexes'],
		['add-post-slug', 'add_post_slug'],
		['Add Post Slug', 'add_post_slug'],
		['addPostSlug', 'add_post_slug'],
		['  lock_songs  ', 'lock_songs']
	])('%s -> %s', (input, expected) => {
		expect(migrationSlug(input)).toBe(expected);
	});

	test.each(['', '   ', '../escape', 'a/b', 'name.js', '_leading', 'ünïcode'])(
		'refuses %j',
		(input) => {
			expect(() => migrationSlug(input)).toThrow(/migration name/);
		}
	);
});

describe('writeBlankMigration', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-migrate-'));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('writes PocketBase’s blank template under a timestamped name', () => {
		const file = writeBlankMigration(tmp, 'lock songs', new Date(1795546027_000));
		expect(file).toBe('1795546027_lock_songs.js');
		expect(fs.readFileSync(path.join(tmp, 'migrations', file), 'utf8')).toBe(BLANK_MIGRATION);
		expect(listMigrationFiles(tmp)).toEqual(new Set([file]));
	});

	test('refuses to overwrite a migration written in the same second', () => {
		const now = new Date(1795546027_000);
		writeBlankMigration(tmp, 'again', now);
		expect(() => writeBlankMigration(tmp, 'again', now)).toThrow('already exists');
	});

	test('writes nothing for a bad name', () => {
		expect(() => writeBlankMigration(tmp, '../x')).toThrow();
		expect(fs.existsSync(path.join(tmp, 'migrations'))).toBe(false);
	});
});

describe('parseMigrateDownOutput', () => {
	test('lists what was reverted', () => {
		expect(parseMigrateDownOutput('Reverted 1_a.js\nReverted 2_b.js\n')).toEqual({
			status: 'reverted',
			files: ['1_a.js', '2_b.js']
		});
	});

	test('nothing to revert', () => {
		expect(parseMigrateDownOutput('No migrations to revert.\n')).toEqual({ status: 'none' });
	});

	test('a declined prompt is not a revert', () => {
		expect(parseMigrateDownOutput('The command has been cancelled\n')).toEqual({
			status: 'cancelled'
		});
		expect(parseMigrateDownOutput('')).toEqual({ status: 'cancelled' });
	});
});

describe('confirmMigrate', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test('--yes skips the question', async () => {
		await expect(
			confirmMigrate('Sure?', { yes: true, command: 'vela migrate down' })
		).resolves.toBe(true);
	});

	test('off a terminal without --yes it refuses and names the flag', async () => {
		vi.stubEnv('CI', '1');
		await expect(confirmMigrate('Sure?', { command: 'vela migrate down' })).rejects.toThrow(
			/vela migrate down.*--yes/
		);
	});
});
