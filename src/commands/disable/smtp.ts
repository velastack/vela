import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';

export const smtp = new Command('smtp')
	.description('disable SMTP configuration')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();

			await withPocketbase(workspaceRootDir, async (pb) => {
				await pb.settings.update({ smtp: { enabled: false } });
			});

			reportResult({
				summary: 'Disabled SMTP.',
				nextSteps: [
					'PocketBase will fall back to the built-in sender for transactional email.',
					'Run `vela enable smtp` to reconfigure.'
				]
			});
		}, 'Failed to disable SMTP.')
	);
