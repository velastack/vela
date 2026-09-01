import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { reportResult } from '../../lib/result-report.ts';
import { addTargetOptions } from '../../lib/server-command.ts';
import { withBackupTarget, type BackupContext } from '../../lib/backup-target.ts';
import {
	applyS3,
	defaultForcePathStyle,
	hasLocalUploads,
	readS3,
	type S3Config,
	type S3Filesystem
} from '../../lib/s3-settings.ts';
import { remotePaths } from '../../lib/remote.ts';

interface Options {
	backups?: boolean;
	force?: boolean;
	endpoint?: string;
	bucket?: string;
	region?: string;
	accessKey?: string;
	secret?: string;
	forcePathStyle?: boolean;
}

export const s3 = addTargetOptions(
	new Command('s3')
		.description('enable S3 file storage')
		.option('--backups', 'configure where backups are kept, not where uploads go')
		.option('--endpoint <url>', 'S3 endpoint URL')
		.option('--bucket <name>', 'S3 bucket name')
		.option('--region <region>', 'S3 region')
		.option('--access-key <key>', 'S3 access key')
		.option('--secret <secret>', 'S3 secret key — prefer VELA_S3_SECRET')
		.option('--force-path-style', 'address the bucket in the path (MinIO, Ceph)')
		.option('--no-force-path-style', 'address the bucket as a subdomain (AWS, R2)')
		.option('--force', 'enable it even though uploads already exist on disk')
		.configureHelp(helpConfig),
	'local'
).action((raw: unknown) =>
	runCommand(() => {
		const options = raw as Options;
		const filesystem: S3Filesystem = options.backups ? 'backups' : 'storage';

		return withBackupTarget(raw, 'enable s3', async (ctx) => {
			if (filesystem === 'storage') await guardExistingUploads(ctx, options);

			const existing = await readS3(ctx.pb, filesystem);
			const config = await promptConfig(options, existing);

			await applyS3(ctx.pb, config, filesystem);

			// The old code swallowed this. A wrong path style is exactly what the
			// test reports, so throwing the message away threw away the diagnosis.
			let failure = '';
			try {
				await ctx.pb.settings.testS3(filesystem);
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}

			if (failure) {
				p.log.warn(
					`The connection test failed — the settings are saved but may be wrong.\n\n` +
						`${pc.dim(failure)}\n\n` +
						`If the bucket is not on AWS or R2, try ${pc.cyan('--force-path-style')}.`
				);
			}

			reportResult({
				summary: failure
					? `Enabled S3 ${label(filesystem)} on ${ctx.targetName}.`
					: `Enabled S3 ${label(filesystem)} on ${ctx.targetName} (connection verified).`,
				nextSteps:
					filesystem === 'backups'
						? [
								'`vela backup create` now writes archives to the bucket instead of the server.',
								'Run `vela disable s3 --backups` to keep them on the server again.'
							]
						: [
								'New uploads go to the bucket. Files already on disk are not moved.',
								'`vela backup create` no longer captures uploads — PocketBase leaves them out whenever S3 is on. Bucket versioning is what protects them now.',
								'Run `vela enable s3 --backups` to get backup archives off the server too.',
								'Run `vela disable s3` to go back to local storage.'
							]
			});
		});
	}, 'Failed to enable S3.')
);

function label(filesystem: S3Filesystem): string {
	return filesystem === 'backups' ? 'backup storage' : 'file storage';
}

/**
 * Refuse to strand files that are already on disk.
 *
 * PocketBase does not migrate anything when the filesystem changes — it simply
 * starts reading somewhere else — so every existing upload 404s from the moment
 * this is switched on. The keys are identical on both sides, which makes the fix
 * a plain sync, and that is worth saying rather than leaving to be discovered.
 */
async function guardExistingUploads(ctx: BackupContext, options: Options): Promise<void> {
	if (options.force) return;
	if (!(await hasLocalUploads(ctx.session, ctx.instance, ctx.workspaceRootDir))) return;

	const from = ctx.session ? `${remotePaths.storage(ctx.instance)}/` : 'data/storage/';
	throw new Error(
		`${ctx.targetName} already has uploaded files on disk.\n\n` +
			`Turning on S3 changes where PocketBase reads from; it does not move anything,\n` +
			`so every one of those files would stop resolving.\n\n` +
			`The layout is the same on both sides, so copying them across is a plain sync:\n\n` +
			`  ${pc.cyan(`rclone copy ${from} <remote>:<bucket>/`)}\n\n` +
			`Do that first, then re-run with ${pc.cyan('--force')}.`
	);
}

async function promptConfig(
	options: Options,
	existing: { endpoint: string; bucket: string; region: string; accessKey: string }
): Promise<S3Config> {
	const endpoint =
		options.endpoint ??
		(await text('S3 endpoint URL', existing.endpoint || 'https://s3.amazonaws.com'));
	const bucket = options.bucket ?? (await text('S3 bucket name', existing.bucket));
	const region = options.region ?? (await text('S3 region', existing.region || 'us-east-1'));
	const accessKey = options.accessKey ?? (await text('S3 access key', existing.accessKey));

	// An access key on the command line is bad enough; a secret there lands in
	// shell history and in `ps` for every user on the machine.
	const secret = options.secret ?? process.env.VELA_S3_SECRET ?? (await password('S3 secret key'));

	const forcePathStyle =
		options.forcePathStyle ??
		(await confirm(
			'Address the bucket in the path? (MinIO, Ceph and most self-hosted gateways need this)',
			defaultForcePathStyle(endpoint)
		));

	return { endpoint, bucket, region, accessKey, secret, forcePathStyle };
}

async function text(message: string, initialValue = ''): Promise<string> {
	const value = await p.text({
		message,
		initialValue,
		validate: (input) => (input?.trim() ? undefined : `${message} is required`)
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value.trim();
}

async function password(message: string): Promise<string> {
	const value = await p.password({
		message,
		validate: (input) => (input ? undefined : `${message} is required`)
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value;
}

async function confirm(message: string, initialValue: boolean): Promise<boolean> {
	const value = await p.confirm({ message, initialValue });
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value;
}
