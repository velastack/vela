import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const analytics = new Command('analytics')
	.description('disable web analytics')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-analytics',
						confirmMessage:
							"Disable analytics? Deletes the analytics component, removes <Analytics /> from the root layout, strips the provider's variables from .env and uninstalls posthog-js.",
						report: {
							summary: 'Disabled analytics.',
							nextSteps: [
								'Remove the PUBLIC_* analytics variables from each deploy target with `vela env unset` if you set them there.'
							],
							task: {
								title: 'Disabling analytics',
								success: 'Disabled analytics',
								error: 'Failed to disable analytics'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable analytics.'
		)
	);
