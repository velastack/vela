import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';

export const smtp = new Command('smtp')
	.description('configure SMTP for transactional email')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();

			const config = await p.group(
				{
					host: () =>
						p.text({
							message: 'SMTP host',
							placeholder: 'smtp.example.com',
							validate: (v) => (v ? undefined : 'Host is required')
						}),
					port: () =>
						p.text({
							message: 'SMTP port',
							initialValue: '587',
							validate: (v) => {
								if (!v) return 'Port is required';
								const n = Number(v);
								if (!Number.isInteger(n) || n <= 0 || n > 65535) return 'Invalid port';
								return undefined;
							}
						}),
					username: () => p.text({ message: 'SMTP username' }),
					password: () => p.password({ message: 'SMTP password' })
				},
				{
					onCancel: () => {
						p.cancel('Operation cancelled.');
						process.exit(0);
					}
				}
			);

			await withPocketbase(workspaceRootDir, async (pb) => {
				await pb.settings.update({
					smtp: {
						enabled: true,
						host: config.host,
						port: parseInt(config.port, 10),
						username: config.username ?? '',
						password: config.password ?? ''
					}
				});
			});

			reportResult({
				summary: 'Enabled SMTP for transactional email.',
				nextSteps: [
					'PocketBase will now send auth/verification email via your SMTP server.',
					'Send a test email from the PocketBase admin UI (Settings → Mail settings).',
					'Run `vela disable smtp` to revert to the built-in fallback sender.'
				]
			});
		}, 'Failed to enable SMTP.')
	);
