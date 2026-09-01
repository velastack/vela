import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { reportResult } from '../../lib/result-report.ts';
import { addTargetOptions } from '../../lib/server-command.ts';
import { withBackupTarget } from '../../lib/backup-target.ts';
import { formatBytes, listBackups, readStorageSettings } from '../../lib/backups.ts';
import { remotePaths } from '../../lib/remote.ts';
import { DEFAULT_BACKUP_DIR } from './create.ts';

export const backupDownload = addTargetOptions(
	new Command('download')
		.description('save a backup off the server')
		.argument('<key>', 'archive to download, as shown by `vela backup list`')
		.option('-o, --output <dir>', 'where to save the archive', DEFAULT_BACKUP_DIR)
		.configureHelp(helpConfig),
	'production'
).action((key: string, raw: unknown) =>
	runCommand(() => {
		const options = raw as { output: string };
		return withBackupTarget(raw, 'backup download', async (ctx) => {
			const found = (await listBackups(ctx.pb)).find((b) => b.key === key);
			if (!found) {
				throw new Error(
					`${ctx.targetName} has no backup called ${pc.cyan(key)}.\n\n` +
						`Run ${pc.cyan('vela backup list')} to see what it does have.`
				);
			}

			// With a backups bucket configured the archive was never written to the
			// server's disk, so there is nothing here to rsync.
			const storage = await readStorageSettings(ctx.pb);
			if (storage.backupsS3Enabled) {
				throw new Error(
					`${key} is in the bucket configured for backups, not on the server.\n\n` +
						`Fetch it from the bucket directly — vela does not hold its credentials.`
				);
			}

			const dir = path.resolve(ctx.workspaceRootDir, options.output);
			fs.mkdirSync(dir, { recursive: true });
			const destination = path.join(dir, key);

			if (!ctx.session) {
				fs.copyFileSync(path.join(ctx.workspaceRootDir, 'data', 'backups', key), destination);
			} else {
				const spinner = p.spinner();
				spinner.start(`Downloading ${key} (${formatBytes(found.size)})`);
				try {
					await ctx.session.download(remotePaths.backup(ctx.instance, key), destination);
				} catch (error) {
					spinner.stop(`Could not download ${key}.`);
					throw error;
				}
				spinner.stop(`Downloaded ${key}`);
			}

			reportResult({
				summary: `Saved ${key} from ${ctx.targetName}.`,
				filesCreated: [path.relative(ctx.workspaceRootDir, destination)]
			});
		});
	}, 'Failed to download the backup.')
);
