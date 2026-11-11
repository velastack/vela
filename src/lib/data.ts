import crypto from 'node:crypto';
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
 *
 * Seeds go to every copy of the app, deployed ones included, and are loaded
 * again on each deploy. So loading them only ever adds: a record whose id is
 * already there is left as it is, whatever has been done to it since.
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
	/** The file is at fault as written, whatever the schema says. */
	readonly malformed: boolean;

	constructor(
		kind: DataKind,
		file: string,
		index: number,
		cause: unknown,
		opts: { malformed?: boolean } = {}
	) {
		super(`${file}, record ${index + 1}: ${describeError(cause)}`);
		this.name = 'DataLoadError';
		this.kind = kind;
		this.file = file;
		this.malformed = opts.malformed ?? false;
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

/** What loading one seed file did. */
export interface SeedLoadResult {
	/** The file and its counts, for output. */
	label: string;
	created: number;
	/** Records whose id was already in the database, left untouched. */
	skipped: number;
}

/** Ids are looked up this many at a time, to keep the filter a sane length. */
const ID_LOOKUP_CHUNK = 50;

/** Which of these ids the collection already holds. */
async function existingIds(
	pb: PocketBase,
	collectionName: string,
	ids: string[]
): Promise<Set<string>> {
	const found = new Set<string>();
	for (let start = 0; start < ids.length; start += ID_LOOKUP_CHUNK) {
		// Asked for by id rather than listed: a deployed collection can hold far
		// more records than its seed file does.
		const filter = ids
			.slice(start, start + ID_LOOKUP_CHUNK)
			.map((id) => `id = ${JSON.stringify(id)}`)
			.join(' || ');
		const records = await pb.collection(collectionName).getFullList({ filter, fields: 'id' });
		for (const record of records) found.add(record.id);
	}
	return found;
}

/**
 * A seeded account has no password to carry: PocketBase never gives one back,
 * so `vela seeds save` has none to write. The account is created with a random
 * one and its owner sets their own through a password reset. A password written
 * into the seed file by hand is used as it is.
 */
function withPassword(record: Record<string, unknown>): Record<string, unknown> {
	if (typeof record.password === 'string' && record.password) {
		return { passwordConfirm: record.password, ...record };
	}
	const password = crypto.randomBytes(24).toString('base64url');
	return { ...record, password, passwordConfirm: password };
}

/**
 * Load every seed file, or the given ones, creating the records that are not
 * there yet.
 *
 * Safe to run against a database any number of times, which is what lets a
 * deploy run it every time. Records are matched by id, so each one needs an id;
 * all the files are checked for that before anything is written.
 */
export async function loadSeeds(
	pb: PocketBase,
	cwd: string,
	seedFiles: DataFile[] = getSeedFiles(cwd)
): Promise<SeedLoadResult[]> {
	const files = seedFiles.map((file) => ({ file, records: readRecords(file.filePath) }));
	if (files.length === 0) return [];

	for (const { file, records } of files) {
		for (const [index, record] of records.entries()) {
			if (typeof record.id === 'string' && record.id) continue;
			throw new DataLoadError(
				'seeds',
				path.relative(cwd, file.filePath),
				index,
				new Error(
					'seed records need an `id`. It is how a record already loaded is told from a new one.'
				),
				{ malformed: true }
			);
		}
	}

	const authCollections = new Set(
		(await pb.collections.getFullList()).filter((c) => c.type === 'auth').map((c) => c.name)
	);

	const results: SeedLoadResult[] = [];
	for (const { file, records } of files) {
		const { collectionName, filePath } = file;
		const relative = path.relative(cwd, filePath);
		const present = await existingIds(
			pb,
			collectionName,
			records.map((record) => record.id as string)
		);
		const isAuth = authCollections.has(collectionName);

		let created = 0;
		for (const [index, record] of records.entries()) {
			if (present.has(record.id as string)) continue;
			try {
				await pb.collection(collectionName).create(isAuth ? withPassword(record) : record);
			} catch (e) {
				throw new DataLoadError('seeds', relative, index, e);
			}
			// Listed twice in one file, the second is as present as any other.
			present.add(record.id as string);
			created++;
		}

		const skipped = records.length - created;
		results.push({
			label:
				`${relative} (${created} created` + (skipped > 0 ? `, ${skipped} already there)` : ')'),
			created,
			skipped
		});
	}
	return results;
}

/** One line for what a seed load did across all its files. */
export function summarizeSeedLoad(results: SeedLoadResult[]): string {
	const created = results.reduce((sum, r) => sum + r.created, 0);
	const skipped = results.reduce((sum, r) => sum + r.skipped, 0);
	const plural = (count: number) => `${count} seed record${count === 1 ? '' : 's'}`;
	if (created === 0 && skipped === 0) return 'No seed records to load.';
	if (created === 0) return `All ${plural(skipped)} already there, nothing to load.`;
	return `Loaded ${plural(created)}` + (skipped > 0 ? `, ${skipped} already there.` : '.');
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
