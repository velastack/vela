import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type PocketBase from 'pocketbase';
import { ClientResponseError } from 'pocketbase';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	DataLoadError,
	getFixtureFiles,
	getSeedFiles,
	loadFixtures,
	loadSeeds,
	readSeedIds
} from './data.ts';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-data-test-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeData(kind: 'seeds' | 'fixtures', file: string, records: unknown[]) {
	const dir = path.join(tmpDir, 'data', kind);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, file), JSON.stringify(records));
}

/** A PocketBase stand-in that records every create. */
function fakePocketbase(
	opts: { create?: (record: unknown) => Promise<unknown>; existing?: unknown[] } = {}
) {
	const created: Array<{ collection: string; record: unknown }> = [];
	const pb = {
		collection: (name: string) => ({
			create: vi.fn(async (record: unknown) => {
				await opts.create?.(record);
				created.push({ collection: name, record });
				return record;
			}),
			getFullList: vi.fn(async () => opts.existing ?? []),
			delete: vi.fn(async () => true)
		})
	};
	return { pb: pb as unknown as PocketBase, created };
}

describe('getSeedFiles / getFixtureFiles', () => {
	test('returns nothing when the directory is missing', () => {
		expect(getSeedFiles(tmpDir)).toEqual([]);
		expect(getFixtureFiles(tmpDir)).toEqual([]);
	});

	test('lists JSON files in name order and strips the numeric prefix', () => {
		writeData('seeds', '02-posts.json', []);
		writeData('seeds', '01-users.json', []);
		writeData('seeds', '10_tags.json', []);
		writeData('seeds', 'plain.json', []);
		fs.writeFileSync(path.join(tmpDir, 'data', 'seeds', 'README.md'), '');

		expect(getSeedFiles(tmpDir).map((f) => f.collectionName)).toEqual([
			'users',
			'posts',
			'tags',
			'plain'
		]);
	});

	test('keeps seeds and fixtures apart', () => {
		writeData('seeds', '01-plans.json', []);
		writeData('fixtures', '01-posts.json', []);

		expect(getSeedFiles(tmpDir).map((f) => f.collectionName)).toEqual(['plans']);
		expect(getFixtureFiles(tmpDir).map((f) => f.collectionName)).toEqual(['posts']);
	});
});

describe('readSeedIds', () => {
	test('collects ids per collection and skips records without one', () => {
		writeData('seeds', '01-plans.json', [{ id: 'plan1' }, { name: 'no id' }, { id: 'plan2' }]);
		writeData('seeds', '02-roles.json', [{ id: 'role1' }]);

		const ids = readSeedIds(tmpDir);
		expect(ids.get('plans')).toEqual(['plan1', 'plan2']);
		expect(ids.get('roles')).toEqual(['role1']);
		expect(ids.has('posts')).toBe(false);
	});
});

describe('loadSeeds', () => {
	test('creates every record in file order and labels each file', async () => {
		writeData('seeds', '01-plans.json', [{ id: 'a' }, { id: 'b' }]);
		writeData('seeds', '02-roles.json', [{ id: 'r' }]);
		const { pb, created } = fakePocketbase();

		const loaded = await loadSeeds(pb, tmpDir);

		expect(loaded).toEqual([
			`${path.join('data', 'seeds', '01-plans.json')} (2 records)`,
			`${path.join('data', 'seeds', '02-roles.json')} (1 records)`
		]);
		expect(created.map((c) => c.collection)).toEqual(['plans', 'plans', 'roles']);
	});

	test('names the file, record, and field PocketBase refused', async () => {
		writeData('seeds', '01-plans.json', [{ id: 'a' }, { id: 'b' }]);
		const { pb } = fakePocketbase({
			create: async (record) => {
				if ((record as { id: string }).id === 'b') {
					throw new ClientResponseError({
						status: 400,
						response: {
							message: 'Failed to create record.',
							data: { name: { code: 'validation_required', message: 'Missing required value.' } }
						}
					});
				}
			}
		});

		const error = await loadSeeds(pb, tmpDir).catch((e) => e);

		expect(error).toBeInstanceOf(DataLoadError);
		expect(error.kind).toBe('seeds');
		expect(error.file).toBe(path.join('data', 'seeds', '01-plans.json'));
		expect(error.message).toBe(
			`${path.join('data', 'seeds', '01-plans.json')}, record 2: Failed to create record. name: Missing required value.`
		);
	});
});

describe('loadFixtures', () => {
	test('loads fixture files and reports them as fixtures on failure', async () => {
		writeData('fixtures', '01-posts.json', [{ id: 'velaposts000001' }]);
		const { pb } = fakePocketbase({
			create: async () => {
				throw new Error('boom');
			}
		});

		const error = await loadFixtures(pb, tmpDir).catch((e) => e);

		expect(error).toBeInstanceOf(DataLoadError);
		expect(error.kind).toBe('fixtures');
		expect(error.message).toBe(`${path.join('data', 'fixtures', '01-posts.json')}, record 1: boom`);
	});

	test('refuses a collection that already holds fixture records', async () => {
		writeData('fixtures', '01-posts.json', [{ id: 'velaposts000001' }]);
		const { pb, created } = fakePocketbase({ existing: [{ id: 'velaposts000001' }] });

		await expect(loadFixtures(pb, tmpDir)).rejects.toThrow(
			'posts collection already has fixture records'
		);
		expect(created).toEqual([]);
	});
});
