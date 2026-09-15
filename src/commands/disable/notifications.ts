import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const notifications = new Command('notifications')
	.description('disable in-app notifications')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-notifications',
						confirmMessage:
							'Disable notifications? Drops the notifications collection, removes the bell, the /notifications page and $lib/server/notifications, and takes the bell out of the (app) layout.',
						report: {
							summary: 'Disabled notifications.',
							nextSteps: [
								'The timeAgo helper enable-notifications added to $lib/utils is kept in case other code uses it.'
							],
							task: {
								title: 'Disabling notifications',
								success: 'Disabled notifications',
								error: 'Failed to disable notifications'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable notifications.'
		)
	);
