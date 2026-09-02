import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { loadFixtures } from '../../lib/data.ts';

export const load = new Command('load')
	.description('load fixtures into the database')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			let loaded: string[] = [];
			await withPocketbase(workspaceRootDir, async (pb) => {
				loaded = await loadFixtures(pb, workspaceRootDir);
			});

			if (loaded.length === 0) {
				reportResult({
					summary: 'No fixture files found in data/fixtures.',
					nextSteps: ['Run `vela fixtures generate` to create fixture files first.']
				});
				return;
			}

			reportResult({
				summary: `Loaded ${loaded.length} fixture file(s) into the database.`,
				recordsLoaded: loaded,
				nextSteps: [
					'Run `vela dev` to see the fixture data in the app.',
					'Run `vela fixtures clear` to remove the loaded fixture records.'
				]
			});
		}, 'Failed to load fixtures.')
	);
