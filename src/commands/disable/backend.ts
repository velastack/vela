import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const backend = new Command('backend')
	.description('disable the PocketBase backend')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-backend',
						confirmMessage:
							'Disable the PocketBase backend? Deletes data/ (the local database, fixtures, hooks and seeds), src/lib/server/workflows.ts, src/lib/workflows/ and every server.test.ts, and uninstalls the workflow packages. Takes the PocketBase handle and workflow worker out of hooks.server.ts (deleting it if nothing else is left) and switches the SvelteKit adapter back to static. The @velastack/pocketbase and pocketbase-sveltekit packages stay installed.',
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
