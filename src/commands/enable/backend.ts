import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const backend = new Command('backend')
	.description('enable the PocketBase backend')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-backend',
					cmd.args,
					{},
					{
						summary: 'Enabled the PocketBase backend.',
						nextSteps: [
							'Set POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL, and POCKETBASE_SUPERUSER_PASSWORD in your environment.',
							'Run `vela dev` to start with PocketBase wired up.',
							'Run `vela enable auth` to add user authentication on top of the backend.'
						],
						task: {
							title: 'Enabling backend',
							success: 'Enabled backend',
							error: 'Failed to enable backend'
						}
					}
				),
			'Failed to enable backend.'
		)
	);
