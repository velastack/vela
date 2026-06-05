import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const backend = new Command('backend')
	.description('disable the PocketBase backend')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-backend',
						confirmMessage:
							'Disable the PocketBase backend? Removes hooks.server.ts, the data/ scaffold, and reverts the SvelteKit adapter. The @velastack/pocketbase and pocketbase-sveltekit packages stay installed.',
						report: {
							summary: 'Disabled the PocketBase backend.',
							task: {
								title: 'Disabling backend',
								success: 'Disabled backend',
								error: 'Failed to disable backend'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable backend.'
		)
	);
