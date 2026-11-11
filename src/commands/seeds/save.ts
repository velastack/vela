import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { dependencyOrder } from '../../lib/collections.ts';
import { reportResult } from '../../lib/result-report.ts';
import { DATA_DIR, FIXTURE_PREFIX } from '../../lib/constants.ts';
import { dataDir, getSeedFiles } from '../../lib/data.ts';

/**
 * What identifies an account, kept although PocketBase marks it as a system
 * field: a seeded account without its email is not one. The password and token
 * key are never given back, so there are none to keep.
 */
const AUTH_IDENTITY_FIELDS = new Set(['email', 'emailVisibility', 'verified']);

const padZeros = (num: number, length: number) => num.toString().padStart(length, '0');

function filterSystemFields(
	record: Record<string, unknown>,
	systemFieldNames: Set<string>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (systemFieldNames.has(key)) continue;
		if (key === 'collectionId' || key === 'collectionName' || key === 'expand') continue;
		out[key] = value;
	}
	return out;
}

export const save = new Command('save')
	.description('save the current data as seeds')
	.option('-f, --force', 'overwrite existing seed files')
	.configureHelp(helpConfig)
	.action((opts: { force?: boolean }) =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			const seedsPath = dataDir(workspaceRootDir, 'seeds');

			const existing = getSeedFiles(workspaceRootDir);
			if (existing.length > 0 && !opts.force) {
				throw new Error('Existing seed files found in data/seeds. Pass --force to overwrite.');
			}

			fs.mkdirSync(seedsPath, { recursive: true });
			if (opts.force) {
				for (const file of fs.readdirSync(seedsPath)) {
					if (file.endsWith('.json')) fs.unlinkSync(path.join(seedsPath, file));
				}
			}

			const saved: string[] = [];

			await withPocketbase(workspaceRootDir, async (pb) => {
				const fullList = await pb.collections.getFullList();
				const collections = fullList.map((c) => ({
					id: c.id,
					name: c.name,
					type: c.type,
					fields: c.fields.map((f) => ({
						name: f.name,
						type: f.type,
						system: f.system,
						collectionId: (f as { collectionId?: string }).collectionId
					}))
				}));

				const { names } = dependencyOrder(collections);

				let count = 1;
				for (const collectionName of names) {
					const collection = collections.find((c) => c.name === collectionName);
					if (!collection) continue;
					if (collection.type === 'view') continue;
					const systemFieldNames = new Set(
						collection.fields
							.filter((f) => f.system && f.name !== 'id')
							.filter((f) => !(collection.type === 'auth' && AUTH_IDENTITY_FIELDS.has(f.name)))
							.map((f) => f.name)
					);

					// Seeds are loaded into deployed copies of the app, and fixtures are
					// mock data: a database with both loaded is saved without them.
					const records = await pb.collection(collectionName).getFullList({
						filter: `id !~ "${FIXTURE_PREFIX}${collectionName.slice(0, 6)}%"`
					});
					if (records.length === 0) continue;

					const filtered = records.map((r) =>
						filterSystemFields(r as Record<string, unknown>, systemFieldNames)
					);

					const relativeSeedPath = path.join(
						DATA_DIR,
						'seeds',
						`${padZeros(count, 2)}-${collectionName}.json`
					);
					const seedPath = path.join(workspaceRootDir, relativeSeedPath);
					fs.writeFileSync(seedPath, JSON.stringify(filtered, null, 2));
					saved.push(`${relativeSeedPath} (${filtered.length} records)`);
					count++;
				}
			});

			if (saved.length === 0) {
				reportResult({
					summary: 'No records to save.',
					nextSteps: [
						'Create the records the app needs first (in the app or its admin panel), then rerun `vela seeds save`. Fixtures are left out.'
					]
				});
				return;
			}

			reportResult({
				summary: `Saved ${saved.length} collection(s) as seeds.`,
				filesCreated: saved,
				nextSteps: [
					'Read through data/seeds/ before committing: `vela deploy` loads these records into every copy of the app.',
					'Run `vela seeds load` to load them here, or `vela seeds load -t production` into a deployed copy.'
				]
			});
		}, 'Failed to save seeds.')
	);
