import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { reportResult } from '../../lib/result-report.ts';
import { addTargetOptions } from '../../lib/server-command.ts';
import { withBackupTarget } from '../../lib/backup-target.ts';
import { disableS3, readS3, type S3Filesystem } from '../../lib/s3-settings.ts';

export const s3 = addTargetOptions(
	new Command('s3')
		.description('disable S3 file storage')
		.option('--backups', 'keep backups on the server again, rather than uploads')
		.configureHelp(helpConfig),
	'local'
).action((raw: unknown) =>
	runCommand(() => {
		const options = raw as { backups?: boolean };
		const filesystem: S3Filesystem = options.backups ? 'backups' : 'storage';

		return withBackupTarget(raw, 'disable s3', async (ctx) => {
			const existing = await readS3(ctx.pb, filesystem);
			if (!existing.enabled) {
				p.log.info(`S3 ${label(filesystem)} is already off for ${ctx.targetName}.`);
				return;
			}

			await disableS3(ctx.pb, filesystem);

			reportResult({
				summary: `Disabled S3 ${label(filesystem)} on ${ctx.targetName}.`,
				nextSteps:
					filesystem === 'backups'
						? ['New backups are written to the server again.']
						: [
								`Anything uploaded while S3 was on is still in ${pc.cyan(existing.bucket || 'the bucket')} and will now 404.`,
								'Copy it back first if you need it: `rclone copy <remote>:<bucket>/ <storage dir>/`.',
								'The credentials are kept, so `vela enable s3` does not mean retyping them.'
							]
			});
		});
	}, 'Failed to disable S3.')
);

function label(filesystem: S3Filesystem): string {
	return filesystem === 'backups' ? 'backup storage' : 'file storage';
}
