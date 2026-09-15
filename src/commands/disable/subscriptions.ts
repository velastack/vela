import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const subscriptions = new Command('subscriptions')
	.description('disable Stripe subscriptions')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-subscriptions',
						confirmMessage:
							'Disable subscriptions? Drops the stripe_subscriptions collection, removes the subscription webhook handlers and sync endpoint, and reverts the billing pages, nav and (app) layout to their payments-only state. Payments stay enabled.',
						report: {
							summary: 'Disabled subscriptions.',
							nextSteps: [
								'Recurring prices in the Stripe dashboard are not deleted — archive them there if you no longer need them.',
								'One-time payments are untouched; run `vela disable payments` to remove Stripe entirely.'
							],
							task: {
								title: 'Disabling subscriptions',
								success: 'Disabled subscriptions',
								error: 'Failed to disable subscriptions'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable subscriptions.'
		)
	);
