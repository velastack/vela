import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const subscriptions = new Command('subscriptions')
	.description('enable Stripe subscriptions (requires auth and payments)')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-subscriptions',
					cmd.args,
					{},
					{
						summary: 'Enabled subscriptions.',
						nextSteps: [
							'Create a recurring price in the Stripe dashboard and add its price_id where users can select a plan.',
							'Forward webhooks locally with `stripe listen --forward-to localhost:5173/webhooks/stripe`.',
							'Run `vela dev` and visit /billing to subscribe, cancel, or resume a plan.'
						],
						task: {
							title: 'Enabling subscriptions',
							success: 'Enabled subscriptions',
							error: 'Failed to enable subscriptions'
						}
					}
				),
			'Failed to enable subscriptions.'
		)
	);
