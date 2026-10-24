import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const orders = new Command('orders')
	.description('disable Stripe Checkout orders')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-orders',
						confirmMessage:
							'Disable orders? Drops the orders and order_lines collections, removes the Checkout Session webhook handlers and the orders pages, and puts the success page back to Stripe’s summary. Payments and the cart stay enabled.',
						report: {
							summary: 'Disabled orders.',
							nextSteps: [
								'Stripe keeps every Checkout Session; the dashboard still lists what was bought.',
								'The cart is untouched; run `vela disable ecommerce` to remove it.'
							],
							task: {
								title: 'Disabling orders',
								success: 'Disabled orders',
								error: 'Failed to disable orders'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable orders.'
		)
	);
