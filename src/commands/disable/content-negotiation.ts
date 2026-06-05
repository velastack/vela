import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const contentNegotiation = new Command('content-negotiation')
	.description('disable content negotiation')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-content-negotiation',
						confirmMessage:
							'Disable content negotiation? Unwraps hooks.server handle, reverts reroute, and removes <Negotiate /> from the root layout.',
						report: {
							summary: 'Disabled content negotiation.',
							task: {
								title: 'Disabling content negotiation',
								success: 'Disabled content negotiation',
								error: 'Failed to disable content negotiation'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable content negotiation.'
		)
	);
