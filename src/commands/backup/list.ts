import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addTargetOptions } from '../../lib/server-command.ts';
import { withBackupTarget } from '../../lib/backup-target.ts';
import { formatBytes, listBackups } from '../../lib/backups.ts';

export const backupList = addTargetOptions(
	new Command('list').description('list the backups on a target').configureHelp(helpConfig),
	'production'
).action((raw: unknown) =>
	runCommand(
		() =>
			withBackupTarget(raw, 'backup list', async (ctx) => {
				const backups = await listBackups(ctx.pb);
				if (backups.length === 0) {
					p.log.info(
						`${pc.cyan(ctx.targetName)} has no backups yet.\n\n` +
							`Take one with ${pc.cyan('vela backup create')}.`
					);
					return;
				}

				const width = Math.max(...backups.map((b) => b.key.length));
				p.log.message(
					backups
						.map(
							(b) =>
								`${b.key.padEnd(width)}  ${pc.dim(formatBytes(b.size).padStart(8))}  ${pc.dim(b.modified)}`
						)
						.join('\n')
				);
			}),
		'Failed to list backups.'
	)
);
