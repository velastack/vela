import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { clearSeeds, getSeedFiles } from '../../lib/data.ts';

export const clear = new Command('clear')
	.description('clear seeded records')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			const seedFiles = getSeedFiles(workspaceRootDir);

			if (seedFiles.length === 0) {
				reportResult({
					summary: 'No seed files found in data/seeds.',
					nextSteps: ['Run `vela seeds save` to create seed files from the current database.']
				});
				return;
			}

			let cleared: string[] = [];
			await withPocketbase(workspaceRootDir, async (pb) => {
				cleared = await clearSeeds(pb, workspaceRootDir, seedFiles);
			});

			if (cleared.length === 0) {
				reportResult({
					summary: 'No seeded records found to clear.',
					nextSteps: ['Run `vela seeds load` to load seed records into the database.']
				});
				return;
			}

			reportResult({
				summary: `Cleared ${cleared.length} seed file(s) worth of records.`,
				recordsCleared: cleared,
				nextSteps: ['Run `vela seeds load` to reload seeds from the files in data/seeds.']
			});
		}, 'Failed to clear seeds.')
	);
