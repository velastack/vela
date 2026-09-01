import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { reportResult } from '../../lib/result-report.ts';
import { addTargetOptions } from '../../lib/server-command.ts';
import { withBackupTarget } from '../../lib/backup-target.ts';
import { readSchedule, readStorageSettings, writeSchedule } from '../../lib/backups.ts';

const DEFAULT_KEEP = 7;

export const backupSchedule = addTargetOptions(
	new Command('schedule')
		.description('back up automatically on a schedule')
		.argument('[cron]', 'when to run, as a cron expression — shows the current one when omitted')
		.option('--keep <n>', 'how many scheduled archives to keep', String(DEFAULT_KEEP))
		.option('--off', 'stop backing up automatically')
		.configureHelp(helpConfig),
	'production'
).action((cron: string | undefined, raw: unknown) =>
	runCommand(() => {
		const options = raw as { keep: string; off?: boolean };
		return withBackupTarget(raw, 'backup schedule', async (ctx) => {
			if (options.off) {
				await writeSchedule(ctx.pb, '', 0);
				reportResult({ summary: `${ctx.targetName} no longer backs up automatically.` });
				return;
			}

			if (!cron) {
				const current = await readSchedule(ctx.pb);
				p.log.info(
					current.cron
						? `${ctx.targetName} backs up on ${pc.cyan(current.cron)}, keeping ${current.maxKeep}.`
						: `${ctx.targetName} has no backup schedule.\n\n` +
								`Set one with ${pc.cyan('vela backup schedule "0 3 * * *"')}.`
				);
				return;
			}

			const keep = Number.parseInt(options.keep, 10);
			if (!Number.isInteger(keep) || keep < 1) {
				throw new Error(
					`${pc.cyan(options.keep)} is not a number of backups to keep — pass at least 1.`
				);
			}

			// PocketBase validates the expression itself, and its message names the
			// part that is wrong, which is more use than anything guessed here.
			await writeSchedule(ctx.pb, cron, keep);

			const storage = await readStorageSettings(ctx.pb);
			reportResult({
				summary: `${ctx.targetName} now backs up on ${cron}, keeping ${keep}.`,
				nextSteps: [
					...(storage.backupsS3Enabled
						? ['Archives go to the bucket configured for backups.']
						: [
								'Archives are written to the server, on the same disk as the data they protect.',
								'Run `vela enable s3 --backups` to send them somewhere else.'
							]),
					...(storage.s3Enabled
						? ['Uploads live in S3, so these archives hold the database only.']
						: []),
					'`--keep` prunes only scheduled archives; ones from `vela backup create` are left alone.'
				]
			});
		});
	}, 'Failed to set the backup schedule.')
);
