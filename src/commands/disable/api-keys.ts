import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const apiKeys = new Command('api-keys')
	.description('disable API key management')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-api-keys',
						confirmMessage:
							'Disable API key management? Drops the api_keys collection, reverts hooks.server and nav-user, and removes generated API key routes.',
						report: {
							summary: 'Disabled API key management.',
							task: {
								title: 'Disabling API keys',
								success: 'Disabled API keys',
								error: 'Failed to disable API keys'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable API keys.'
		)
	);
