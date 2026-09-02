import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { clearFixtures, loadFixtures } from '../../lib/data.ts';

export const reset = new Command('reset')
	.description('clear and reload fixtures')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			let cleared: string[] = [];
			let loaded: string[] = [];
			await withPocketbase(workspaceRootDir, async (pb) => {
				cleared = await clearFixtures(pb, workspaceRootDir);
				loaded = await loadFixtures(pb, workspaceRootDir);
			});

			if (loaded.length === 0) {
				reportResult({
					summary: 'No fixture files found in data/fixtures.',
					recordsCleared: cleared,
					nextSteps: ['Run `vela fixtures generate` to create fixture files first.']
				});
				return;
			}

			reportResult({
				summary: `Reset fixtures (${loaded.length} collection(s) reloaded).`,
				recordsCleared: cleared,
				recordsLoaded: loaded,
				nextSteps: [
					'Run `vela dev` to see the freshly reloaded fixture data.',
					'Run `vela fixtures regen` if you also want to regenerate the fixture files.'
				]
			});
		}, 'Failed to reset fixtures.')
	);
