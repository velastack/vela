import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { dependencyOrder } from '../../lib/collections.ts';
import { reportResult } from '../../lib/result-report.ts';
import { getSeedFiles } from './load.ts';

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
			const seedsPath = path.join(workspaceRootDir, 'data', 'seeds');

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
					const systemFieldNames = new Set(
						collection.fields.filter((f) => f.system && f.name !== 'id').map((f) => f.name)
					);

					const records = await pb.collection(collectionName).getFullList();
					if (records.length === 0) continue;

					const filtered = records.map((r) =>
						filterSystemFields(r as Record<string, unknown>, systemFieldNames)
					);

					const relativeSeedPath = path.join(
						'data',
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
						'Create some records first (via the app, `vela fixtures load`, or the PocketBase admin UI), then rerun `vela seeds save`.'
					]
				});
				return;
			}

			reportResult({
				summary: `Saved ${saved.length} collection(s) as seeds.`,
				filesCreated: saved,
				nextSteps: [
					'Commit the new files under data/seeds/ so teammates get the same starting data.',
					'Run `vela seeds load` on a fresh database to restore this snapshot.'
				]
			});
		}, 'Failed to save seeds.')
	);
