import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';

export const s3 = new Command('s3')
	.description('disable S3 file storage')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();

			await withPocketbase(workspaceRootDir, async (pb) => {
				await pb.settings.update({ s3: { enabled: false } });
			});

			reportResult({
				summary: 'Disabled S3 file storage.',
				nextSteps: [
					'PocketBase will store uploads on the local filesystem again.',
					'Run `vela enable s3` to reconfigure S3 storage.'
				]
			});
		}, 'Failed to disable S3.')
	);
