import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const api = new Command('api')
	.description('enable the PocketBase REST API')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-api',
					cmd.args,
					{},
					{
						summary: 'Enabled the PocketBase REST API.',
						nextSteps: [
							'Run `vela dev` to try the API at /api/collections/*.',
							'Adjust collection-level rules in the PocketBase admin UI or via migrations.',
							'Run `vela enable api-keys` if you want to issue machine-to-machine tokens.'
						],
						task: {
							title: 'Enabling api',
							success: 'Enabled api',
							error: 'Failed to enable api'
						}
					}
				),
			'Failed to enable API.'
		)
	);
