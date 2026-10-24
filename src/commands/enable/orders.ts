import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const orders = new Command('orders')
	.description('record Stripe Checkout orders (requires Stripe payments and the cart)')
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-orders',
					cmd.args,
					{},
					{
						summary: 'Enabled orders.',
						nextSteps: [
							'Forward webhooks locally with `stripe listen --forward-to localhost:5173/webhooks/stripe`.',
							'Run `vela dev`, buy something from the shop, and see the order on /checkout/success.',
							'With auth on, signed-in buyers see their orders at /orders.'
						],
						task: {
							title: 'Enabling orders',
							success: 'Enabled orders',
							error: 'Failed to enable orders'
						}
					}
				),
			'Failed to enable orders.'
		)
	);
