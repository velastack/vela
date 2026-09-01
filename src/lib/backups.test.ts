import { describe, expect, test } from 'vitest';
import { backupName, formatBytes, isBackupKey } from './backups.ts';

/**
 * The regex here is PocketBase's own, copied from `apis/backup_create.go`. A
 * name it rejects fails the request with a validation error rather than
 * anything that names the cause, so every generated name has to satisfy it.
 */
const POCKETBASE_RULE = /^[a-z0-9_-]+\.zip$/;

describe('backupName', () => {
	const at = new Date('2026-09-01T13:45:01.000Z');

	test('is accepted by PocketBase and carries the instance and time', () => {
		const name = backupName('myapp', at);
		expect(name).toBe('vela_myapp_20260901134501.zip');
		expect(name).toMatch(POCKETBASE_RULE);
	});

	test('keeps the double dash of a non-production instance', () => {
		expect(backupName('myapp--staging', at)).toBe('vela_myapp--staging_20260901134501.zip');
	});

	test.each([
		['UPPERCASE', 'vela_uppercase_20260901134501.zip'],
		['app.with.dots', 'vela_app-with-dots_20260901134501.zip'],
		['sp ace/slash', 'vela_sp-ace-slash_20260901134501.zip'],
		['--edges--', 'vela_edges_20260901134501.zip']
	])('slugs %s into something valid', (instance, expected) => {
		const name = backupName(instance, at);
		expect(name).toBe(expected);
		expect(name).toMatch(POCKETBASE_RULE);
	});

	test('survives an id that is nothing but disallowed characters', () => {
		const name = backupName('///', at);
		expect(name).toMatch(POCKETBASE_RULE);
	});

	test('stays inside PocketBase 150 character limit', () => {
		const name = backupName('x'.repeat(400), at);
		expect(name.length).toBeLessThanOrEqual(150);
		expect(name).toMatch(POCKETBASE_RULE);
	});
});

describe('isBackupKey', () => {
	test.each(['vela_myapp_20260901134501.zip', 'pb_backup_app_20260901134501.zip', 'a.zip'])(
		'accepts %s',
		(key) => expect(isBackupKey(key)).toBe(true)
	);

	test.each([
		'Vela_Myapp.zip',
		'backup.tar.gz',
		'./backups/vela_myapp.zip',
		'vela_myapp.zip.bak',
		'.zip'
	])('rejects %s', (key) => expect(isBackupKey(key)).toBe(false));
});

describe('formatBytes', () => {
	test.each([
		[0, '0 B'],
		[512, '512 B'],
		[1024, '1.0 KB'],
		[1536, '1.5 KB'],
		[1024 * 1024 * 20, '20 MB'],
		[1024 * 1024 * 1024 * 3.5, '3.5 GB']
	])('%i formats as %s', (bytes, expected) => {
		expect(formatBytes(bytes)).toBe(expected);
	});
});
