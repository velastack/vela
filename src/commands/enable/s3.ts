import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';

export const s3 = new Command('s3')
	.description('enable S3 file storage')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();

			const config = await p.group(
				{
					endpoint: () =>
						p.text({
							message: 'S3 endpoint URL',
							initialValue: 'https://s3.amazonaws.com',
							validate: (v) => (v ? undefined : 'Endpoint is required')
						}),
					accessKey: () =>
						p.text({
							message: 'S3 access key',
							validate: (v) => (v ? undefined : 'Access key is required')
						}),
					secret: () =>
						p.password({
							message: 'S3 secret key',
							validate: (v) => (v ? undefined : 'Secret key is required')
						}),
					bucket: () =>
						p.text({
							message: 'S3 bucket name',
							validate: (v) => (v ? undefined : 'Bucket name is required')
						}),
					region: () =>
						p.text({
							message: 'S3 region',
							initialValue: 'us-east-1',
							validate: (v) => (v ? undefined : 'Region is required')
						})
				},
				{
					onCancel: () => {
						p.cancel('Operation cancelled.');
						process.exit(0);
					}
				}
			);

			let connectionOk = false;
			await withPocketbase(workspaceRootDir, async (pb) => {
				await pb.settings.update({
					s3: {
						enabled: true,
						endpoint: config.endpoint,
						accessKey: config.accessKey,
						secret: config.secret,
						bucket: config.bucket,
						region: config.region
					}
				});

				try {
					await pb.settings.testS3();
					connectionOk = true;
				} catch {
					connectionOk = false;
				}
			});

			if (!connectionOk) {
				p.log.warn('S3 connection test failed — credentials are saved but may be incorrect.');
			}

			reportResult({
				summary: connectionOk
					? 'Enabled S3 file storage (connection verified).'
					: 'Enabled S3 file storage.',
				nextSteps: [
					'Uploads in PocketBase will now be stored in S3.',
					'Run `vela disable s3` to revert to local storage.'
				]
			});
		}, 'Failed to enable S3.')
	);
