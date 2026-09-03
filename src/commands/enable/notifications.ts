import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const notifications = new Command('notifications')
	.description('enable in-app notifications with a bell dropdown (requires auth)')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-notifications',
					cmd.args,
					{},
					{
						summary: 'Enabled notifications.',
						nextSteps: [
							'Run `vela dev` and open any (app) page to see the bell in the header; /notifications lists them all.',
							'Send one from server code with `notify(locals.admin, userId, { title, body })` from $lib/server/notifications.',
							'Customize the bell in src/lib/components/notifications-bell.svelte and the page in src/routes/(app)/notifications/.'
						],
						task: {
							title: 'Enabling notifications',
							success: 'Enabled notifications',
							error: 'Failed to enable notifications'
						}
					}
				),
			'Failed to enable notifications.'
		)
	);
