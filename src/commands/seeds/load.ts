import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { getSeedFiles, loadSeeds } from '../../lib/data.ts';

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

			let loaded: string[] = [];

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

				loaded = await loadSeeds(pb, workspaceRootDir, seedFiles);
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
