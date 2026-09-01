import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { reportResult } from '../../lib/result-report.ts';
import { addTargetOptions } from '../../lib/server-command.ts';
import { withBackupTarget, type BackupContext } from '../../lib/backup-target.ts';
import {
	backupName,
	checkpointAppDatabases,
	createBackup,
	formatBytes,
	isBackupKey,
	listBackups,
	readStorageSettings
} from '../../lib/backups.ts';
import { remotePaths } from '../../lib/remote.ts';

export const DEFAULT_BACKUP_DIR = 'backups';

export const backupCreate = addTargetOptions(
	new Command('create')
		.description('take a backup of the database and uploads')
		.argument('[name]', 'name for the archive — generated when omitted')
		.option('-o, --output <dir>', 'where to save the archive', DEFAULT_BACKUP_DIR)
		.option('--no-download', 'leave the archive on the server')
		.configureHelp(helpConfig),
	'production'
).action((name: string | undefined, raw: unknown) =>
	runCommand(() => {
		const options = raw as { output: string; download: boolean };
		return withBackupTarget(raw, 'backup create', async (ctx) => {
			const key = name ?? backupName(ctx.instance);
			if (!isBackupKey(key)) {
				throw new Error(
					`${pc.cyan(key)} is not a name PocketBase will accept.\n\n` +
						`Backup names are lowercase letters, digits, ${pc.cyan('-')} and ${pc.cyan('_')}, ` +
						`ending in ${pc.cyan('.zip')}.`
				);
			}

			const storage = await readStorageSettings(ctx.pb);
			if (storage.s3Enabled) {
				p.log.warn(
					`Uploads are stored in S3, so this archive holds the database only.\n\n` +
						`PocketBase leaves ${pc.cyan('storage/')} out of a backup whenever S3 is on.\n` +
						`Your bucket's own versioning is what protects the uploaded files.`
				);
			}

			// PocketBase flushes the write-ahead logs of its own databases before it
			// archives the directory. Anything the app keeps alongside them has to be
			// asked separately, or the archive holds a database and a log that
			// describe different moments.
			if (ctx.session) await checkpointAppDatabases(ctx.session, ctx.instance);

			const spinner = p.spinner();
			spinner.start(`Backing up ${ctx.targetName}`);
			try {
				await createBackup(ctx.pb, key);
			} catch (error) {
				spinner.stop(`Backup of ${ctx.targetName} failed.`);
				throw error;
			}

			const size = (await listBackups(ctx.pb)).find((b) => b.key === key)?.size ?? 0;
			spinner.stop(`Backed up ${ctx.targetName} — ${key} (${formatBytes(size)})`);

			if (storage.backupsS3Enabled) {
				reportResult({
					summary: `Backed up ${ctx.targetName} to your backups bucket.`,
					nextSteps: [
						`The archive is ${key} in the bucket configured for backups, not on the server.`,
						'Run `vela backup list` to see what is stored there.'
					]
				});
				return;
			}

			if (!options.download) {
				reportResult({
					summary: `Backed up ${ctx.targetName}.`,
					nextSteps: [
						`${key} is on the server, in the directory it is a backup of.`,
						'Run `vela backup download ' + key + '` to keep a copy off the box.'
					]
				});
				return;
			}

			const saved = await download(ctx, key, options.output);
			reportResult({
				summary: `Backed up ${ctx.targetName} — ${formatBytes(size)}.`,
				filesCreated: [saved],
				nextSteps: [`Restore it with \`vela restore ${key}\`.`]
			});
		});
	}, 'Failed to create the backup.')
);

/**
 * Bring the archive off the machine it protects.
 *
 * PocketBase writes it into `pb_data/backups`, inside the very directory being
 * backed up, so a backup that is never downloaded survives exactly the failures
 * that do not matter.
 */
async function download(ctx: BackupContext, key: string, outputDir: string): Promise<string> {
	const dir = path.resolve(ctx.workspaceRootDir, outputDir);
	fs.mkdirSync(dir, { recursive: true });
	const destination = path.join(dir, key);

	if (!ctx.session) {
		fs.copyFileSync(path.join(ctx.workspaceRootDir, 'data', 'backups', key), destination);
		return path.relative(ctx.workspaceRootDir, destination);
	}

	const spinner = p.spinner();
	spinner.start(`Downloading ${key}`);
	try {
		await ctx.session.download(remotePaths.backup(ctx.instance, key), destination);
	} catch (error) {
		spinner.stop(`Could not download ${key}.`);
		throw error;
	}
	spinner.stop(`Downloaded ${key}`);
	return path.relative(ctx.workspaceRootDir, destination);
}
