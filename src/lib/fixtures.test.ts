import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type PocketBase from 'pocketbase';
import {
	INTERNAL_COLLECTIONS,
	fillRequired,
	parseCountFor,
	prepareFixtureSchema,
	selectFixtureCollections,
	type FixtureCollection
} from './fixtures.ts';
import { generateFixtureFiles, internalSkippedNote } from '../commands/fixtures/generate.ts';

const collection = (
	name: string,
	fields: FixtureCollection['fields'] = [],
	type = 'base'
): FixtureCollection => ({ id: `id_${name}`, name, type, fields });

const COLLECTIONS = [
	collection('_superusers', [], 'auth'),
	collection('users', [{ name: 'name', type: 'text' }], 'auth'),
	collection('oauth_accounts', [
		{ name: 'user', type: 'relation', required: true, collectionId: 'id_users' }
	]),
	collection('songs', [
		{ name: 'title', type: 'text', required: true },
		{ name: 'year', type: 'number' },
		{ name: 'position', type: 'number', required: true },
		{ name: 'announced', type: 'bool', required: true }
	]),
	collection('votes', [
		{ name: 'song', type: 'relation', required: true, collectionId: 'id_songs' }
	]),
	collection('song_stats', [], 'view')
];

describe('selectFixtureCollections', () => {
	const names = (options?: Parameters<typeof selectFixtureCollections>[1]) =>
		selectFixtureCollections(COLLECTIONS, options).selected.map((c) => c.name);

	test('leaves out system collections, views and pattern-internal collections', () => {
		const { selected, internalSkipped } = selectFixtureCollections(COLLECTIONS);
		expect(selected.map((c) => c.name)).toEqual(['users', 'songs', 'votes']);
		expect(internalSkipped).toEqual(['oauth_accounts']);
		expect(INTERNAL_COLLECTIONS).toContain('oauth_accounts');
	});

	test('--only is taken as given, internal collections included', () => {
		expect(names({ only: ['songs'] })).toEqual(['songs']);
		expect(names({ only: ['oauth_accounts', 'users'] })).toEqual(['users', 'oauth_accounts']);
	});

	test('--skip leaves collections out', () => {
		expect(names({ skip: ['votes'] })).toEqual(['users', 'songs']);
	});

	test('an internal collection something generated requires is kept', () => {
		const withKeys = [
			...COLLECTIONS,
			collection('api_keys'),
			collection('usage', [
				{ name: 'key', type: 'relation', required: true, collectionId: 'id_api_keys' }
			])
		];
		const { selected, internalSkipped } = selectFixtureCollections(withKeys);
		expect(selected.map((c) => c.name)).toContain('api_keys');
		expect(internalSkipped).toEqual(['oauth_accounts']);
		// The user's own --skip is not overruled.
		expect(
			selectFixtureCollections(withKeys, { skip: ['api_keys'] }).selected.map((c) => c.name)
		).not.toContain('api_keys');
	});

	test.each([
		['--only', { only: ['sogns'] }],
		['--skip', { skip: ['sogns'] }],
		['--count-for', { counts: { sogns: 3 } }]
	])('%s with an unknown collection is an error naming the real ones', (flag, options) => {
		expect(() => selectFixtureCollections(COLLECTIONS, options)).toThrow(
			new RegExp(`${flag}: no collection named sogns.*songs`)
		);
	});
});

describe('parseCountFor', () => {
	test('collects name=count pairs', () => {
		expect(parseCountFor('participants=13', parseCountFor('songs=64'))).toEqual({
			songs: 64,
			participants: 13
		});
	});

	test.each(['songs', 'songs=', 'songs=0', 'songs=1000', '=4', 'songs=four'])(
		'refuses %j',
		(value) => {
			expect(() => parseCountFor(value)).toThrow(/<collection>=<count>/);
		}
	);
});

describe('prepareFixtureSchema', () => {
	const schema = {
		type: 'object',
		required: ['position', 'title'],
		properties: {
			position: { type: 'number', faker: 'person.jobTitle' },
			year: { type: 'number' },
			slot: { type: 'integer', minimum: 1, maximum: 8 },
			floor: { type: 'number', minimum: 10 },
			ceiling: { type: 'number', maximum: -5 },
			cap: { type: 'number', maximum: 5 },
			title: { type: 'string', faker: 'music.songName' },
			announced: { type: 'boolean', faker: 'lorem.word' }
		}
	};
	const prepared = prepareFixtureSchema(schema).properties;

	test('unbounded numbers become whole numbers in 0..1000, required ones from 1', () => {
		expect(prepared.year).toEqual({ type: 'integer', minimum: 0, maximum: 1000 });
		expect(prepared.position).toEqual({ type: 'integer', minimum: 1, maximum: 1000 });
	});

	test('bounds the schema gives are kept, and a missing side is filled in', () => {
		expect(prepared.slot).toEqual({ type: 'integer', minimum: 1, maximum: 8 });
		expect(prepared.floor).toEqual({ type: 'number', minimum: 10, maximum: 1010 });
		expect(prepared.ceiling).toEqual({ type: 'number', minimum: -1005, maximum: -5 });
		expect(prepared.cap).toEqual({ type: 'number', minimum: 0, maximum: 5 });
	});

	test('a name hint survives on text only', () => {
		expect(prepared.title.faker).toBe('music.songName');
		expect(prepared.position.faker).toBeUndefined();
		expect(prepared.announced.faker).toBeUndefined();
	});

	test('the schema passed in is not changed', () => {
		expect(schema.properties.year).toEqual({ type: 'number' });
	});
});

describe('fillRequired', () => {
	const schema = {
		required: ['position', 'title', 'announced', 'state', 'tags'],
		properties: {
			position: { type: 'integer', minimum: 1, maximum: 1000 },
			title: { type: 'string' },
			announced: { type: 'boolean' },
			state: { type: 'string', enum: ['open', 'closed'] },
			tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
			year: { type: 'integer', minimum: 0, maximum: 1000 }
		}
	};

	test('fills what is missing, null or blank with a value PocketBase takes as present', () => {
		const record: Record<string, unknown> = {
			position: null,
			title: '',
			announced: false,
			tags: [],
			year: null
		};
		fillRequired(record, schema);
		expect(record.position).toBeGreaterThanOrEqual(1);
		expect(record.position).toBeLessThanOrEqual(1000);
		expect(Number.isInteger(record.position)).toBe(true);
		expect(record.title).toMatch(/\S/);
		expect(record.announced).toBe(true);
		expect(['open', 'closed']).toContain(record.state);
		expect(record.tags).toHaveLength(1);
		// Optional fields are left as generated.
		expect(record.year).toBeNull();
	});

	test('leaves good values alone', () => {
		const record = { position: 7, title: 'Hey Jude', announced: true, state: 'open', tags: ['b'] };
		fillRequired(record, schema);
		expect(record).toEqual({
			position: 7,
			title: 'Hey Jude',
			announced: true,
			state: 'open',
			tags: ['b']
		});
	});

	test('a required number is not left at 0', () => {
		const record: Record<string, unknown> = { position: 0 };
		fillRequired(record, {
			required: ['position'],
			properties: { position: { type: 'integer', minimum: 0, maximum: 5 } }
		});
		expect(record.position).toBeGreaterThanOrEqual(1);
	});
});

describe('generateFixtureFiles', () => {
	let tmp: string;
	const pb = {
		collections: { getFullList: async () => COLLECTIONS }
	} as unknown as PocketBase;
	const fixtures = () => path.join(tmp, 'data', 'fixtures');
	const read = (file: string) =>
		JSON.parse(fs.readFileSync(path.join(fixtures(), file), 'utf8')) as Record<string, unknown>[];

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-fixtures-'));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('required fields are never null, numbers are bounded whole numbers, counts apply per collection', async () => {
		const result = await generateFixtureFiles(pb, tmp, {
			count: 3,
			counts: { songs: 12 },
			seed: 1
		});

		expect(fs.readdirSync(fixtures()).sort()).toEqual([
			'01-users.json',
			'02-songs.json',
			'03-votes.json'
		]);
		expect(result.internalSkipped).toEqual(['oauth_accounts']);
		expect(internalSkippedNote(result.internalSkipped)).toContain('--only oauth_accounts');

		const songs = read('02-songs.json');
		expect(songs).toHaveLength(12);
		expect(read('01-users.json')).toHaveLength(3);
		const songIds = new Set(songs.map((song) => song.id));
		for (const song of songs) {
			expect(Number.isInteger(song.position)).toBe(true);
			expect(song.position).toBeGreaterThanOrEqual(1);
			expect(song.position).toBeLessThanOrEqual(1000);
			expect(Number.isInteger(song.year)).toBe(true);
			expect(song.year).toBeGreaterThanOrEqual(0);
			expect(song.year).toBeLessThanOrEqual(1000);
			expect(song.title).toMatch(/\S/);
			expect(song.announced).toBe(true);
		}
		for (const vote of read('03-votes.json')) expect(songIds.has(vote.song as string)).toBe(true);
	});

	test('--only rewrites its own file in place and leaves the others', async () => {
		await generateFixtureFiles(pb, tmp, { count: 2, seed: 1 });
		const users = fs.readFileSync(path.join(fixtures(), '01-users.json'), 'utf8');
		fs.writeFileSync(path.join(fixtures(), '02-songs.json'), '[{"id":"handmade","title":"Mine"}]');

		const result = await generateFixtureFiles(pb, tmp, { count: 4, only: ['votes'], seed: 2 });

		expect(result.writtenFiles).toEqual([
			`${path.join('data', 'fixtures', '03-votes.json')} (4 records)`
		]);
		expect(fs.readFileSync(path.join(fixtures(), '01-users.json'), 'utf8')).toBe(users);
		expect(read('02-songs.json')).toEqual([{ id: 'handmade', title: 'Mine' }]);
		// Related to the songs that are in the file left alone.
		for (const vote of read('03-votes.json')) expect(vote.song).toBe('handmade');
	});

	test('--only for a collection with no file yet numbers it after the rest', async () => {
		await generateFixtureFiles(pb, tmp, { count: 1, seed: 1 });
		await generateFixtureFiles(pb, tmp, { count: 1, only: ['oauth_accounts'], seed: 1 });
		expect(fs.readdirSync(fixtures()).sort()).toEqual([
			'01-users.json',
			'02-songs.json',
			'03-votes.json',
			'04-oauth_accounts.json'
		]);
	});

	test('a mistyped collection is refused before any file is removed', async () => {
		await generateFixtureFiles(pb, tmp, { count: 1, seed: 1 });
		await expect(generateFixtureFiles(pb, tmp, { count: 1, counts: { sogns: 4 } })).rejects.toThrow(
			'no collection named sogns'
		);
		expect(fs.readdirSync(fixtures())).toHaveLength(3);
	});
});
