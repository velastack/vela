import fs from 'node:fs';
import path from 'node:path';
import PocketBase, { ClientResponseError } from 'pocketbase';
import { DATA_DIR, FIXTURE_PREFIX } from './constants.ts';
import { dependencyOrder } from './collections.ts';

/**
 * Seeds are the data an app needs to function — plans, roles, an initial
 * admin — and ship with it. Fixtures are mock data for development and tests.
 * Both are JSON files under `data/<kind>`, one per collection, loaded through
 * the PocketBase API so the app's hooks see them like any other write.
 */
export type DataKind = 'seeds' | 'fixtures';

export interface DataFile {
	collectionName: string;
	filePath: string;
}

export function dataDir(cwd: string, kind: DataKind): string {
	return path.join(cwd, DATA_DIR, kind);
}

/**
 * The JSON files under `data/<kind>` in load order. A leading numeric prefix
 * (`01-plans.json`) orders the files without being part of the collection name.
 */
export function getDataFiles(cwd: string, kind: DataKind): DataFile[] {
	const dir = dataDir(cwd, kind);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((file) => file.endsWith('.json'))
		.sort((a, b) => a.localeCompare(b))
		.map((file) => ({
			collectionName: file.replace(/\.json$/i, '').replace(/^\d+[-_]?/, ''),
			filePath: path.join(dir, file)
		}));
}

export function getSeedFiles(cwd: string): DataFile[] {
	return getDataFiles(cwd, 'seeds');
}

export function getFixtureFiles(cwd: string): DataFile[] {
	return getDataFiles(cwd, 'fixtures');
}

export function readRecords(filePath: string): Array<Record<string, unknown>> {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Seed record ids by collection name. Fixtures load after seeds, so a fixture
 * may relate to a seeded record — generation draws relation targets from here.
 */
export function readSeedIds(cwd: string): Map<string, string[]> {
	const ids = new Map<string, string[]>();
	for (const { collectionName, filePath } of getSeedFiles(cwd)) {
		const list = ids.get(collectionName) ?? [];
		for (const record of readRecords(filePath)) {
			if (typeof record.id === 'string' && record.id) list.push(record.id);
		}
		ids.set(collectionName, list);
	}
	return ids;
}

/** Fixture ids carry a known prefix, which is how they are found again. */
export function fixtureFilter(collectionName: string): string {
	return `id ~ "${FIXTURE_PREFIX}${collectionName.slice(0, 6)}%"`;
}

/** A record in a seed or fixture file that PocketBase refused. */
export class DataLoadError extends Error {
	readonly kind: DataKind;
	readonly file: string;

	constructor(kind: DataKind, file: string, index: number, cause: unknown) {
		super(`${file}, record ${index + 1}: ${describeError(cause)}`);
		this.name = 'DataLoadError';
		this.kind = kind;
		this.file = file;
	}
}

function describeError(e: unknown): string {
	if (e instanceof ClientResponseError) {
		const data: unknown = e.response?.data;
		const details =
			data && typeof data === 'object'
				? Object.entries(data as Record<string, { message?: string } | undefined>).map(
						([field, detail]) => `${field}: ${detail?.message ?? JSON.stringify(detail)}`
					)
				: [];
		return [e.message, ...details].join(' ');
	}
	return e instanceof Error ? e.message : String(e);
}

function label(cwd: string, filePath: string, count: number): string {
	return `${path.relative(cwd, filePath)} (${count} records)`;
}

async function createRecords(
	pb: PocketBase,
	kind: DataKind,
	cwd: string,
	{ collectionName, filePath }: DataFile
): Promise<number> {
	const records = readRecords(filePath);
	for (const [index, record] of records.entries()) {
		try {
			await pb.collection(collectionName).create(record);
		} catch (e) {
			throw new DataLoadError(kind, path.relative(cwd, filePath), index, e);
		}
	}
	return records.length;
}

/** Load every seed file, or the given ones, returning a label per file. */
export async function loadSeeds(
	pb: PocketBase,
	cwd: string,
	seedFiles: DataFile[] = getSeedFiles(cwd)
): Promise<string[]> {
	const loaded: string[] = [];
	for (const file of seedFiles) {
		const count = await createRecords(pb, 'seeds', cwd, file);
		loaded.push(label(cwd, file.filePath, count));
	}
	return loaded;
}

export async function clearSeeds(
	pb: PocketBase,
	cwd: string,
	seedFiles: DataFile[] = getSeedFiles(cwd)
): Promise<string[]> {
	const cleared: string[] = [];
	for (const { collectionName, filePath } of seedFiles) {
		const seeds = readRecords(filePath) as Array<{ id: string }>;
		for (const { id } of seeds) {
			await pb.collection(collectionName).delete(id);
		}
		cleared.push(label(cwd, filePath, seeds.length));
	}
	return cleared;
}

/** Load every fixture file, refusing a collection that already holds fixtures. */
export async function loadFixtures(pb: PocketBase, cwd: string): Promise<string[]> {
	const loaded: string[] = [];
	for (const file of getFixtureFiles(cwd)) {
		const existing = await pb.collection(file.collectionName).getFullList({
			filter: fixtureFilter(file.collectionName),
			fields: 'id'
		});
		if (existing.length > 0) {
			throw new Error(
				`${file.collectionName} collection already has fixture records. ` +
					'Run `vela fixtures reset` to clear and reload, or `vela fixtures clear` first.'
			);
		}
		const count = await createRecords(pb, 'fixtures', cwd, file);
		loaded.push(label(cwd, file.filePath, count));
	}
	return loaded;
}

/** Remove fixture records from every collection, dependents first. */
export async function clearFixtures(pb: PocketBase, cwd: string): Promise<string[]> {
	const fixturePathByName = new Map(
		getFixtureFiles(cwd).map((f) => [f.collectionName, f.filePath])
	);

	const cleared: string[] = [];
	const fullList = await pb.collections.getFullList();
	const collections = fullList.map((c) => ({
		id: c.id,
		name: c.name,
		fields: c.fields.map((f) => ({
			type: f.type,
			collectionId: (f as { collectionId?: string }).collectionId
		}))
	}));

	const { names } = dependencyOrder(collections);
	const reversed = [...names].reverse();

	for (const collectionName of reversed) {
		const records = await pb.collection(collectionName).getFullList({
			filter: fixtureFilter(collectionName),
			fields: 'id'
		});

		if (records.length === 0) continue;

		for (const { id } of records) {
			await pb.collection(collectionName).delete(id);
		}
		const fixturePath = fixturePathByName.get(collectionName);
		cleared.push(
			fixturePath
				? label(cwd, fixturePath, records.length)
				: `${collectionName} (${records.length} records)`
		);
	}

	return cleared;
}

export async function hasLoadedFixtures(pb: PocketBase): Promise<boolean> {
	const fullList = await pb.collections.getFullList();
	for (const collection of fullList) {
		if (collection.name.startsWith('_')) continue;
		const page = await pb.collection(collection.name).getList(1, 1, {
			filter: fixtureFilter(collection.name),
			fields: 'id'
		});
		if (page.totalItems > 0) return true;
	}
	return false;
}
