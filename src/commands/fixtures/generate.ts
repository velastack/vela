import fs from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import * as p from '@clack/prompts';
import type PocketBase from 'pocketbase';
import { annotate } from 'annotate-json-schema';
import { createGenerator, type JsonSchema } from 'json-schema-faker';
import { faker } from '@faker-js/faker';
import { collectionToJsonSchema } from '@velastack/pocketbase/internal';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { dependencyOrder } from '../../lib/collections.ts';
import { FIXTURE_PREFIX } from '../../lib/constants.ts';
import { reportResult } from '../../lib/result-report.ts';
import { clearFixtures } from './clear.ts';
import { getFixtureFiles } from './load.ts';

const SKIP_TYPES = new Set(['autodate', 'file', 'relation']);
const AUTH_OVERRIDE_FIELDS = ['email', 'password', 'passwordConfirm', 'tokenKey'];

function padZeros(num: number, length: number) {
	return num.toString().padStart(length, '0');
}

function parseCount(value: string): number {
	const n = parseInt(value, 10);
	if (!Number.isFinite(n) || n <= 0 || n > 999) {
		throw new InvalidArgumentError('count must be between 1 and 999');
	}
	return n;
}

function parseSeed(value: string): number {
	const n = parseInt(value, 10);
	if (!Number.isFinite(n)) {
		throw new InvalidArgumentError('seed must be an integer');
	}
	return n;
}

export async function hasLoadedFixtures(pb: PocketBase): Promise<boolean> {
	const fullList = await pb.collections.getFullList();
	for (const collection of fullList) {
		if (collection.name.startsWith('_')) continue;
		const shortName = collection.name.slice(0, 6);
		const page = await pb.collection(collection.name).getList(1, 1, {
			filter: `id ~ "${FIXTURE_PREFIX}${shortName}%"`,
			fields: 'id'
		});
		if (page.totalItems > 0) return true;
	}
	return false;
}

type CollectionSummary = Parameters<typeof collectionToJsonSchema>[0];
type FieldSummary = CollectionSummary['fields'][number];

async function loadCollections(pb: PocketBase): Promise<CollectionSummary[]> {
	const list = await pb.collections.getFullList();
	return list.map((c) => ({
		id: c.id,
		name: c.name,
		type: c.type as CollectionSummary['type'],
		fields: c.fields as FieldSummary[]
	}));
}

export interface GenerateFixturesOptions {
	count: number;
	seed?: number;
}

export interface GenerateFixturesResult {
	writtenFiles: string[];
	warnings: string[];
}

export async function generateFixtureFiles(
	pb: PocketBase,
	workspaceRootDir: string,
	opts: GenerateFixturesOptions
): Promise<GenerateFixturesResult> {
	const fixturesDir = path.join(workspaceRootDir, 'data', 'fixtures');
	fs.mkdirSync(fixturesDir, { recursive: true });
	for (const file of fs.readdirSync(fixturesDir)) {
		if (file.endsWith('.json')) fs.unlinkSync(path.join(fixturesDir, file));
	}

	if (opts.seed !== undefined) faker.seed(opts.seed);
	const generator = createGenerator({
		extensions: { faker },
		alwaysFakeOptionals: true,
		...(opts.seed !== undefined ? { seed: opts.seed } : {})
	});

	const collections = await loadCollections(pb);
	const eligible = collections.filter((c) => !c.name.startsWith('_') && c.type !== 'view');
	const { ids } = dependencyOrder(eligible);

	const recordIds = new Map<string, string[]>();
	ids.forEach((id) => recordIds.set(id, []));

	const writtenFiles: string[] = [];
	const warnings: string[] = [];
	let fileIndex = 1;
	for (const collectionId of ids) {
		const collection = eligible.find((c) => c.id === collectionId);
		if (!collection) continue;

		for (const f of collection.fields) {
			if (f.type !== 'relation' || !f.required) continue;
			const pool = f.collectionId ? recordIds.get(f.collectionId) : undefined;
			if (!pool || pool.length === 0) {
				const target = collections.find((c) => c.id === f.collectionId);
				const targetLabel = target?.name ?? f.collectionId ?? '<unknown>';
				warnings.push(
					`${collection.name}.${f.name} requires a ${targetLabel} record, but none were generated yet`
				);
			}
		}

		const schema = collectionToJsonSchema(collection);
		const properties = schema.properties as Record<string, unknown>;
		delete properties.id;
		for (const f of collection.fields) {
			if (SKIP_TYPES.has(f.type)) delete properties[f.name];
		}
		if (collection.type === 'auth') {
			for (const name of AUTH_OVERRIDE_FIELDS) delete properties[name];
		}
		schema.required = schema.required.filter((name) => name in properties);

		const annotated = annotate(schema as JsonSchema, collection.name);

		const items: Record<string, unknown>[] = [];
		for (let idx = 0; idx < opts.count; idx++) {
			const record = (await generator.generate(annotated)) as Record<string, unknown>;

			const shortName = collection.name.slice(0, 6);
			const remaining = 15 - shortName.length - FIXTURE_PREFIX.length;
			const id = `${FIXTURE_PREFIX}${shortName}${padZeros(idx + 1, remaining)}`;
			record.id = id;
			recordIds.get(collection.id)!.push(id);

			for (const f of collection.fields) {
				if (f.type !== 'relation') continue;
				const parentIds = f.collectionId ? (recordIds.get(f.collectionId) ?? []) : [];
				if (parentIds.length === 0) continue;
				const multi = f.maxSelect !== undefined && f.maxSelect > 1;
				record[f.name] = multi
					? [faker.helpers.arrayElement(parentIds)]
					: faker.helpers.arrayElement(parentIds);
			}

			if (collection.type === 'auth') {
				record.email = `${faker.string.uuid()}@example.com`;
				record.password = 'password';
				record.passwordConfirm = 'password';
			}

			items.push(record);
		}

		const filename = `${padZeros(fileIndex, 2)}-${collection.name}.json`;
		fs.writeFileSync(path.join(fixturesDir, filename), JSON.stringify(items, null, 2));
		writtenFiles.push(`${path.join('data', 'fixtures', filename)} (${items.length} records)`);
		fileIndex++;
	}

	return { writtenFiles, warnings };
}

export const generate = new Command('generate')
	.description('generate fixture data')
	.option('-c, --count <count>', 'number of records per collection', parseCount, 10)
	.option('-s, --seed <seed>', 'seed for deterministic output', parseSeed)
	.option('-f, --force', 'overwrite existing fixture files and clear loaded fixtures')
	.configureHelp(helpConfig)
	.action((opts: { count: number; seed?: number; force?: boolean }) =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			const existing = getFixtureFiles(workspaceRootDir);

			if (existing.length > 0 && !opts.force) {
				await withPocketbase(workspaceRootDir, async (pb) => {
					const loaded = await hasLoadedFixtures(pb);
					if (loaded) {
						throw new Error(
							'Existing fixture files found and fixtures are loaded in the database. ' +
								'Run `vela fixtures reset` to clear + reload, or `vela fixtures clear` then `vela fixtures generate --force`.'
						);
					}
					throw new Error(
						'Existing fixture files found in data/fixtures. Pass --force to overwrite.'
					);
				});
				return;
			}

			let result: GenerateFixturesResult = { writtenFiles: [], warnings: [] };
			let cleared: string[] = [];
			await withPocketbase(workspaceRootDir, async (pb) => {
				if (opts.force) {
					cleared = await clearFixtures(pb, workspaceRootDir);
				}
				result = await generateFixtureFiles(pb, workspaceRootDir, {
					count: opts.count,
					seed: opts.seed
				});
			});

			for (const warning of result.warnings) p.log.warn(warning);

			if (result.writtenFiles.length === 0) {
				reportResult({
					summary: 'No eligible collections found to generate fixtures for.',
					nextSteps: [
						'Create collections with `vela generate scaffold <model>` or in the PocketBase admin UI.',
						'Run `vela fixtures generate` again once you have at least one collection.'
					]
				});
				return;
			}

			reportResult({
				summary: `Generated fixture files for ${result.writtenFiles.length} collection(s).`,
				filesCreated: result.writtenFiles,
				recordsCleared: cleared,
				nextSteps: [
					'Run `vela fixtures load` to load the generated fixtures into the database.',
					'Edit the JSON files under data/fixtures/ to customize the generated data.'
				]
			});
		}, 'Failed to generate fixtures.')
	);
