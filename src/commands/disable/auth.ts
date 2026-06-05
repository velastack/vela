import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const auth = new Command('auth')
	.description('disable authentication')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-auth',
						confirmMessage:
							'Disable auth? Removes auth routes, drops oauth_accounts, and reverts layout/hooks edits. The users collection and existing accounts are preserved.',
						report: {
							summary: 'Disabled authentication.',
							nextSteps: [
								'Users collection and accounts are kept. Drop them manually in the PocketBase admin if you no longer need them.'
							],
							task: {
								title: 'Disabling auth',
								success: 'Disabled auth',
								error: 'Failed to disable auth'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable auth.'
		)
	);
