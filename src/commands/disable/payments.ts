import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { assertBackendReady } from '../../lib/backend-gate.ts';
import { detectWorkspace, hasBackend } from '../../lib/workspace.ts';
import { runCommand, runDisable } from './_shared.ts';

const STRIPE = {
	confirmMessage:
		'Disable payments? Drops Stripe collections, strips Stripe env credentials, reverts nav/signup edits, and removes generated payment files. Stripe dashboard products/prices and the stripe packages are untouched.',
	nextSteps: [
		'Products and prices in the Stripe dashboard are not deleted — archive them there if you no longer need them.',
		'The stripe and @stripe/stripe-js packages remain installed. Uninstall them manually if desired.'
	]
};

const SHOPIFY = {
	confirmMessage:
		'Disable payments? Removes the Shopify client, the Buy button and demo page, and the Shopify env credentials. Your Shopify store is untouched.',
	nextSteps: [
		'The @shopify/storefront-api-client package remains installed. Uninstall it manually if desired.'
	]
};

export const payments = new Command('payments')
	.description('disable payments')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(async () => {
			const { detected } = await detectWorkspace();
			const provider = detected.providers.payments;
			// Stripe's collections are dropped through PocketBase. With no
			// provider detected every provider's files go, and the collections
			// too when there is a backend to drop them from.
			if (provider === 'stripe' || (provider === undefined && hasBackend())) {
				assertBackendReady('vela disable payments');
			}
			const copy = provider === 'shopify' ? SHOPIFY : STRIPE;

			await runDisable(
				{
					slug: 'disable-payments',
					confirmMessage: copy.confirmMessage,
					report: {
						summary: 'Disabled payments.',
						nextSteps: copy.nextSteps,
						task: {
							title: 'Disabling payments',
							success: 'Disabled payments',
							error: 'Failed to disable payments'
						}
					}
				},
				opts,
				cmd.args
			);
		}, 'Failed to disable payments.')
	);
