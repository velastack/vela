import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const api = new Command('api')
	.description('disable the REST API')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-api',
						confirmMessage: 'Disable the REST API? Removes the PocketBase API handler.',
						report: {
							summary: 'Disabled the REST API.',
							task: {
								title: 'Disabling API',
								success: 'Disabled API',
								error: 'Failed to disable API'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable API.'
		)
	);
