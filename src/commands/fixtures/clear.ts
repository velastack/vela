import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { clearFixtures } from '../../lib/data.ts';

export const clear = new Command('clear')
	.description('clear loaded fixtures')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			let cleared: string[] = [];
			await withPocketbase(workspaceRootDir, async (pb) => {
				cleared = await clearFixtures(pb, workspaceRootDir);
			});

			if (cleared.length === 0) {
				reportResult({
					summary: 'No fixtures to clear.',
					nextSteps: [
						'Run `vela fixtures generate` to create fixture files.',
						'Run `vela fixtures load` to load them into the database.'
					]
				});
				return;
			}

			reportResult({
				summary: `Cleared ${cleared.length} fixture collection(s) from the database.`,
				recordsCleared: cleared,
				nextSteps: [
					'Run `vela fixtures load` to reload the existing fixture files.',
					'Run `vela fixtures generate --force` to regenerate fixture files from scratch.'
				]
			});
		}, 'Failed to clear fixtures.')
	);
