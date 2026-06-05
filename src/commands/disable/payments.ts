import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const payments = new Command('payments')
	.description('disable payments')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-payments',
						confirmMessage:
							'Disable payments? Drops Stripe collections, strips Stripe env credentials, reverts nav/signup edits, and removes generated payment files. Stripe dashboard products/prices and the stripe packages are untouched.',
						report: {
							summary: 'Disabled payments.',
							nextSteps: [
								'Products and prices in the Stripe dashboard are not deleted — archive them there if you no longer need them.',
								'The stripe and @stripe/stripe-js packages remain installed. Uninstall them manually if desired.'
							],
							task: {
								title: 'Disabling payments',
								success: 'Disabled payments',
								error: 'Failed to disable payments'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable payments.'
		)
	);
