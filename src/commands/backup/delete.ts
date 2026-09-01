import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { reportResult } from '../../lib/result-report.ts';
import { addTargetOptions } from '../../lib/server-command.ts';
import { withBackupTarget } from '../../lib/backup-target.ts';
import { formatBytes, listBackups } from '../../lib/backups.ts';

export const backupDelete = addTargetOptions(
	new Command('delete')
		.description('remove a backup from a target')
		.argument('<key>', 'archive to delete, as shown by `vela backup list`')
		.option('-y, --yes', 'skip the confirmation')
		.configureHelp(helpConfig),
	'production'
).action((key: string, raw: unknown) =>
	runCommand(() => {
		const options = raw as { yes?: boolean };
		return withBackupTarget(raw, 'backup delete', async (ctx) => {
			const found = (await listBackups(ctx.pb)).find((b) => b.key === key);
			if (!found) {
				throw new Error(
					`${ctx.targetName} has no backup called ${pc.cyan(key)}.\n\n` +
						`Run ${pc.cyan('vela backup list')} to see what it does have.`
				);
			}

			if (!options.yes) {
				const confirmed = await p.confirm({
					message: `Delete ${key} (${formatBytes(found.size)}) from ${ctx.targetName}?`,
					initialValue: false
				});
				if (p.isCancel(confirmed) || !confirmed) {
					p.cancel('Operation cancelled.');
					process.exit(0);
				}
			}

			await ctx.pb.backups.delete(key);
			reportResult({ summary: `Deleted ${key} from ${ctx.targetName}.` });
		});
	}, 'Failed to delete the backup.')
);
