import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { addTargetOptions, withTarget, type ServerContext } from '../lib/server-command.ts';
import { withRemotePocketbase } from '../lib/remote-pocketbase.ts';
import { readInstanceStates, remotePaths, runServerScript } from '../lib/remote.ts';
import { formatBytes, isBackupKey, listBackups, type BackupFile } from '../lib/backups.ts';
import { isProd } from '../lib/instance.ts';

interface RestoreResult {
	previousDataDir: string;
	storageCarriedOver: boolean;
	migrated: boolean;
}

export const restore = addTargetOptions(
	new Command('restore')
		.description('replace a deployment’s database and uploads from a backup')
		.argument('[source]', 'a backup key on the target, or a path to a local archive')
		.configureHelp(helpConfig),
	'production'
)
	.option('-y, --yes', 'skip the confirmation prompt')
	.option('--no-migrate', 'do not run migrations against the restored database')
	.option('--keep-previous <n>', 'how many replaced databases to keep', '1')
	.action((source: string | undefined, raw: unknown) =>
		runCommand(async () => {
			const options = raw as { yes?: boolean; migrate: boolean; keepPrevious: string };
			await withTarget(
				raw,
				{
					remote: async (ctx) => {
						const [state] = await readInstanceStates(ctx.session, ctx.instance);
						if (state && state.backend === false) {
							throw new Error(
								`${ctx.targetName} was deployed without a database, so there is nothing to restore.`
							);
						}

						const local = source && fs.existsSync(source) ? source : undefined;
						const key = local ? undefined : await resolveKey(ctx, source);

						if (!options.yes) {
							await confirm(ctx.appName, ctx.targetName, ctx.envTag, local ?? key!);
						}

						const archive = local
							? await stage(ctx, local)
							: remotePaths.backup(ctx.instance, key!);

						const result = await runServerScript<RestoreResult>(ctx.session, 'restore.sh', {
							args: [
								ctx.instance,
								'--archive',
								archive,
								'--keep-previous',
								options.keepPrevious,
								...(options.migrate ? [] : ['--no-migrate']),
								// A copy this machine pushed up is scratch; one already in the
								// instance's own backups directory is not ours to delete.
								...(local ? ['--cleanup-archive'] : [])
							],
							stream: true
						});

						p.log.success(
							`Restored ${pc.cyan(`${ctx.appName} (${ctx.targetName})`)} from ${pc.cyan(
								local ? path.basename(local) : key!
							)}.`
						);

						if (result?.storageCarriedOver) {
							p.log.info(
								'The archive held no uploads, so the files already on the server were kept.'
							);
						}
						if (result?.previousDataDir) {
							p.log.info(
								`The database this replaced is at ${pc.cyan(result.previousDataDir)}.\n\n` +
									`It is the only way back. Remove it once you are satisfied with the restore.`
							);
						}
					}
				},
				{
					label: 'restore',
					localHint:
						'Restoring the local database is not supported yet — recreate it with `vela migrate up` and `vela seeds load`.'
				}
			);
		}, 'Failed to restore the backup.')
	);

/** Work out which archive on the target to restore, asking when not told. */
async function resolveKey(ctx: ServerContext, source: string | undefined): Promise<string> {
	if (source && !isBackupKey(source)) {
		throw new Error(
			`${pc.cyan(source)} is neither a file on this machine nor a backup key.\n\n` +
				`Run ${pc.cyan('vela backup list')} to see what ${ctx.targetName} has.`
		);
	}

	const backups = await withRemotePocketbase(ctx.session, ctx.instance, listBackups);
	if (source) {
		if (!backups.some((b) => b.key === source)) {
			throw new Error(
				`${ctx.targetName} has no backup called ${pc.cyan(source)}.\n\n` +
					`Run ${pc.cyan('vela backup list')} to see what it does have.`
			);
		}
		return source;
	}

	if (backups.length === 0) {
		throw new Error(
			`${ctx.targetName} has no backups to restore from.\n\n` +
				`Take one with ${pc.cyan('vela backup create')}, or pass the path to an archive on this machine.`
		);
	}

	const chosen = await p.select({
		message: `Which backup should ${ctx.targetName} be restored from?`,
		options: backups.map((b: BackupFile) => ({
			value: b.key,
			label: b.key,
			hint: `${formatBytes(b.size)}, ${b.modified}`
		}))
	});
	if (p.isCancel(chosen)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return chosen;
}

/**
 * Put a local archive somewhere the server can unpack it.
 *
 * Deliberately not `pb_data/backups`: that directory is moved aside during the
 * restore, so an archive placed there would disappear halfway through reading it.
 */
async function stage(ctx: ServerContext, file: string): Promise<string> {
	const dir = remotePaths.restoreStage(ctx.instance);
	const remote = `${dir}/${path.basename(file)}`;

	const spinner = p.spinner();
	spinner.start(`Uploading ${path.basename(file)}`);
	try {
		await ctx.session.script(`mkdir -p "$1"`, { args: [dir] });
		await ctx.session.upload([file], dir);
	} catch (error) {
		spinner.stop(`Could not upload ${path.basename(file)}.`);
		throw error;
	}
	spinner.stop(`Uploaded ${path.basename(file)}`);
	return remote;
}

async function confirm(
	appName: string,
	targetName: string,
	envTag: string,
	from: string
): Promise<void> {
	const what = `${pc.cyan(`${appName} (${targetName})`)} from ${pc.cyan(path.basename(from))}`;

	// A restore overwrites a live database. On production that deserves the same
	// deliberate typing that destroying it does.
	if (isProd(envTag)) {
		const answer = await p.text({
			message: `This replaces the database and uploads of ${what}. Type the app name to confirm`,
			validate: (value) => (value === appName ? undefined : `Type ${appName} to confirm`)
		});
		if (p.isCancel(answer)) {
			p.cancel('Operation cancelled.');
			process.exit(0);
		}
		return;
	}

	const ok = await p.confirm({
		message: `Replace the database and uploads of ${what}?`,
		initialValue: false
	});
	if (p.isCancel(ok) || !ok) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
}
