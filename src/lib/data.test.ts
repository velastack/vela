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
	readSeedIds,
	summarizeSeedLoad
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

/**
 * A PocketBase stand-in that records every create.
 *
 * `existing` answers every list as given, filter or not. `stored` is the ids a
 * collection holds, and answers a list with the ones its filter names, which is
 * how a seed load asks what is already there.
 */
function fakePocketbase(
	opts: {
		create?: (record: unknown) => Promise<unknown>;
		existing?: unknown[];
		stored?: Record<string, string[]>;
		auth?: string[];
	} = {}
) {
	const created: Array<{ collection: string; record: Record<string, unknown> }> = [];
	const filters: string[] = [];
	const pb = {
		collections: {
			getFullList: vi.fn(async () => (opts.auth ?? []).map((name) => ({ name, type: 'auth' })))
		},
		collection: (name: string) => ({
			create: vi.fn(async (record: Record<string, unknown>) => {
				await opts.create?.(record);
				created.push({ collection: name, record });
				return record;
			}),
			getFullList: vi.fn(async (query?: { filter?: string }) => {
				if (opts.existing) return opts.existing;
				const filter = query?.filter ?? '';
				filters.push(filter);
				return (opts.stored?.[name] ?? [])
					.filter((id) => filter.includes(`id = ${JSON.stringify(id)}`))
					.map((id) => ({ id }));
			}),
			delete: vi.fn(async () => true)
		})
	};
	return { pb: pb as unknown as PocketBase, created, filters };
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
			{
				label: `${path.join('data', 'seeds', '01-plans.json')} (2 created)`,
				created: 2,
				skipped: 0
			},
			{
				label: `${path.join('data', 'seeds', '02-roles.json')} (1 created)`,
				created: 1,
				skipped: 0
			}
		]);
		expect(created.map((c) => c.collection)).toEqual(['plans', 'plans', 'roles']);
		expect(summarizeSeedLoad(loaded)).toBe('Loaded 3 seed records.');
	});

	test('creates only the records whose id is not there yet', async () => {
		writeData('seeds', '01-plans.json', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
		const { pb, created } = fakePocketbase({ stored: { plans: ['a', 'c', 'unrelated'] } });

		const loaded = await loadSeeds(pb, tmpDir);

		expect(created.map((c) => c.record.id)).toEqual(['b']);
		expect(loaded).toEqual([
			{
				label: `${path.join('data', 'seeds', '01-plans.json')} (1 created, 2 already there)`,
				created: 1,
				skipped: 2
			}
		]);
		expect(summarizeSeedLoad(loaded)).toBe('Loaded 1 seed record, 2 already there.');
	});

	test('writes nothing to a database that already has every seed', async () => {
		writeData('seeds', '01-plans.json', [{ id: 'a' }, { id: 'b' }]);
		const { pb, created } = fakePocketbase({ stored: { plans: ['a', 'b'] } });

		const loaded = await loadSeeds(pb, tmpDir);

		expect(created).toEqual([]);
		expect(summarizeSeedLoad(loaded)).toBe('All 2 seed records already there, nothing to load.');
	});

	test('creates a record listed twice in one file only once', async () => {
		writeData('seeds', '01-plans.json', [{ id: 'a' }, { id: 'a' }]);
		const { pb, created } = fakePocketbase();

		const [result] = await loadSeeds(pb, tmpDir);

		expect(created).toHaveLength(1);
		expect(result).toMatchObject({ created: 1, skipped: 1 });
	});

	test('asks for existing ids by id, in chunks, rather than listing the collection', async () => {
		const records = Array.from({ length: 120 }, (_, i) => ({ id: `id${i}` }));
		writeData('seeds', '01-plans.json', records);
		const { pb, created, filters } = fakePocketbase({ stored: { plans: ['id7', 'id119'] } });

		await loadSeeds(pb, tmpDir);

		expect(filters).toHaveLength(3);
		expect(filters.every((filter) => filter.length > 0)).toBe(true);
		expect(filters[0]).toContain('id = "id0" || id = "id1"');
		expect(created).toHaveLength(118);
	});

	test('refuses a record without an id before writing anything', async () => {
		writeData('seeds', '01-plans.json', [{ id: 'a' }]);
		writeData('seeds', '02-roles.json', [{ id: 'r' }, { name: 'no id' }]);
		const { pb, created } = fakePocketbase();

		const error = await loadSeeds(pb, tmpDir).catch((e) => e);

		expect(error).toBeInstanceOf(DataLoadError);
		expect(error.malformed).toBe(true);
		expect(error.message).toContain(`${path.join('data', 'seeds', '02-roles.json')}, record 2:`);
		expect(error.message).toContain('seed records need an `id`');
		expect(created).toEqual([]);
	});

	test('gives a seeded account a random password, and keeps one written by hand', async () => {
		writeData('seeds', '01-users.json', [
			{ id: 'u1', email: 'a@example.com' },
			{ id: 'u2', email: 'b@example.com' },
			{ id: 'u3', email: 'c@example.com', password: 'hand-written' }
		]);
		writeData('seeds', '02-plans.json', [{ id: 'p1' }]);
		const { pb, created } = fakePocketbase({ auth: ['users'] });

		await loadSeeds(pb, tmpDir);

		const [u1, u2, u3, plan] = created.map((c) => c.record);
		expect(u1!.password).toEqual(expect.any(String));
		expect((u1!.password as string).length).toBeGreaterThanOrEqual(20);
		expect(u1!.passwordConfirm).toBe(u1!.password);
		expect(u2!.password).not.toBe(u1!.password);
		expect(u3).toMatchObject({ password: 'hand-written', passwordConfirm: 'hand-written' });
		expect(plan).toEqual({ id: 'p1' });
	});

	test('reports no seed files as nothing loaded, without asking the database', async () => {
		const { pb } = fakePocketbase();
		expect(await loadSeeds(pb, tmpDir)).toEqual([]);
		expect(pb.collections.getFullList).not.toHaveBeenCalled();
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
		expect(error.malformed).toBe(false);
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
