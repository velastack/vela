import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';

export function getSeedFiles(cwd: string): Array<{ collectionName: string; seedPath: string }> {
	const seedsDir = path.join(cwd, 'data', 'seeds');
	if (!fs.existsSync(seedsDir)) return [];
	return fs
		.readdirSync(seedsDir)
		.filter((file) => file.endsWith('.json'))
		.map((file) => path.join(seedsDir, file))
		.sort((a, b) => a.localeCompare(b))
		.map((seedPath) => {
			const file = path.basename(seedPath);
			const nameWithoutExt = file.replace(/\.json$/i, '');
			const collectionName = nameWithoutExt.replace(/^\d+[-_]?/, '');
			return { collectionName, seedPath };
		});
}

export const load = new Command('load')
	.description('load seeds into the database')
	.option('-f, --force', 'load even if target collections already have records')
	.configureHelp(helpConfig)
	.action((opts: { force?: boolean }) =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			const seedFiles = getSeedFiles(workspaceRootDir);

			if (seedFiles.length === 0) {
				reportResult({
					summary: 'No seed files found in data/seeds.',
					nextSteps: ['Run `vela seeds save` to snapshot the current database contents as seeds.']
				});
				return;
			}

			const loaded: string[] = [];

			await withPocketbase(workspaceRootDir, async (pb) => {
				if (!opts.force) {
					for (const { collectionName } of seedFiles) {
						const page = await pb.collection(collectionName).getList(1, 1, { fields: 'id' });
						if (page.totalItems > 0) {
							throw new Error(
								`${collectionName} collection already has records. Pass --force to load anyway.`
							);
						}
					}
				}

				for (const { collectionName, seedPath } of seedFiles) {
					const seeds = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as Array<
						Record<string, unknown>
					>;
					for (const seed of seeds) {
						await pb.collection(collectionName).create(seed);
					}
					loaded.push(`${path.relative(workspaceRootDir, seedPath)} (${seeds.length} records)`);
				}
			});

			reportResult({
				summary: `Loaded ${loaded.length} seed file(s) into the database.`,
				recordsLoaded: loaded,
				nextSteps: [
					'Run `vela dev` to see the seeded data in the app.',
					'Run `vela seeds clear` to remove the seeded records.'
				]
			});
		}, 'Failed to load seeds.')
	);
