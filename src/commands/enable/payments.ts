import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import type { Provider } from '@velastack/patterns';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { assertBackendReady } from '../../lib/backend-gate.ts';
import { assertPatternRequires } from '../../lib/require-features.ts';
import {
	collectProviderEnv,
	isInteractive,
	missingEnvKeys,
	resolveProvider
} from '../../lib/providers.ts';

export const payments = new Command('payments')
	.description('enable payments (Stripe or Shopify)')
	.option('--provider <provider>', 'payment provider: stripe or shopify')
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts: { provider?: string }, cmd) =>
		runCommand(async () => {
			const provider = await resolveProvider('enable-payments', opts.provider);

			// Refuse before asking for keys: Stripe needs a backend and workflows.
			await assertPatternRequires('enable-payments', provider.id);
			if (provider.id === 'stripe') assertBackendReady('vela enable payments');

			if (provider.id === 'stripe') noteWebhookSecret();
			const providerEnv = await collectProviderEnv(provider);
			const demoId = await askDemoId(provider);
			const blank = missingEnvKeys(provider, providerEnv);

			await runPattern(
				'enable-payments',
				cmd.args,
				{ provider: provider.id, providerEnv, demoId },
				{
					summary: `Enabled ${provider.label} payments.`,
					nextSteps: [
						...blank.map((key) => `Set ${key} in .env.`),
						...NEXT_STEPS[provider.id],
						'Set the same variables on each deploy target with `vela env set`.'
					],
					task: {
						title: 'Enabling payments',
						success: 'Enabled payments',
						error: 'Failed to enable payments'
					}
				}
			);
		}, 'Failed to enable payments.')
	);

const NEXT_STEPS: Record<string, string[]> = {
	stripe: [
		'Forward Stripe webhooks locally with `stripe listen --forward-to localhost:5173/webhooks/stripe`.',
		'Run `vela dev` and visit /payment to run through the checkout flow.',
		'Add products and prices in the Stripe dashboard.'
	],
	shopify: [
		'Run `vela dev` and visit /payment to try the Buy button (it is there when you gave a variant).',
		'Products, prices and checkout settings live in Shopify admin.'
	]
};

/** Where the signing secret comes from, before it is asked for. */
function noteWebhookSecret() {
	if (process.env.STRIPE_WEBHOOK_SECRET || !isInteractive()) return;
	p.note(
		[
			'Download the Stripe CLI (https://stripe.com/docs/stripe-cli), then run:',
			'  stripe listen --forward-to localhost:5173/webhooks/stripe',
			'Copy the whsec_... value it prints and paste it as the webhook signing secret.'
		].join('\n'),
		'Stripe webhook signing secret',
		{ format: (line) => line }
	);
}

/**
 * The item the demo page sells. Stripe creates a test product when this is
 * blank; Shopify, which keeps products in Shopify admin, writes no page.
 */
async function askDemoId(provider: Provider): Promise<string> {
	if (!isInteractive()) return '';
	const value =
		provider.id === 'stripe'
			? await p.text({
					message: 'Stripe price_id for the demo page (price_...)',
					placeholder: 'leave blank to create a demo product'
				})
			: await p.text({
					message: 'Shopify product variant for the demo page (gid://shopify/ProductVariant/...)',
					placeholder: 'leave blank to skip the demo page'
				});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return (value ?? '').trim();
}
