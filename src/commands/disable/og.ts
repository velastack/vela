import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const og = new Command('og')
	.description('disable generated Open Graph images')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-og',
						confirmMessage:
							'Disable Open Graph images? Deletes the card (including any changes to src/lib/og/card.svelte), its renderer and the /og route, takes withCard off the root layout and uninstalls @takumi-rs/core.',
						report: {
							summary: 'Disabled Open Graph images.',
							nextSteps: ['Pages share the site-wide `static/og.jpg` again.'],
							task: {
								title: 'Disabling Open Graph images',
								success: 'Disabled Open Graph images',
								error: 'Failed to disable Open Graph images'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable Open Graph images.'
		)
	);
