import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { assertPatternRequires } from '../../lib/require-features.ts';
import { resolveProvider } from '../../lib/providers.ts';
import { detectWorkspace } from '../../lib/workspace.ts';

export const ecommerce = new Command('ecommerce')
	.description("enable a cart and checkout on the project's payments provider")
	.option('--provider <provider>', 'must match the payments provider: stripe, shopify or whatsapp')
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts: { provider?: string }, cmd) =>
		runCommand(async () => {
			// The cart follows payments: no provider prompt, and no env to ask
			// for, since payments wrote the keys.
			const { detected, features } = await detectWorkspace();
			// A second run would write over a cart the developer has edited.
			if (features.ecommerce) {
				throw new Error(
					[
						'This project already has a cart (src/lib/cart.svelte.ts). Nothing was changed.',
						'To start over, run `vela disable ecommerce` first, then this again.'
					].join('\n')
				);
			}
			const provider = await resolveProvider('enable-ecommerce', opts.provider, detected.providers);
			await assertPatternRequires('enable-ecommerce', provider.id);

			await runPattern(
				'enable-ecommerce',
				cmd.args,
				{ provider: provider.id },
				{
					summary: `Enabled a ${provider.label} cart.`,
					nextSteps: [
						'Run `vela generate shop` for a product listing and product pages, or put `<AddToCart>` (src/lib/components/cart/add-to-cart.svelte) on your own pages.',
						...NEXT_STEPS[provider.id]
					],
					task: {
						title: 'Enabling ecommerce',
						success: 'Enabled ecommerce',
						error: 'Failed to enable ecommerce'
					}
				}
			);
		}, 'Failed to enable ecommerce.')
	);

const NEXT_STEPS: Record<string, string[]> = {
	stripe: [
		'Checkout is Stripe Checkout: payment methods, tax and shipping are set in the Stripe dashboard.'
	],
	shopify: ["Checkout is Shopify's: payment, tax and shipping settings live in Shopify admin."],
	whatsapp: [
		'Give each item an id, a name and, optionally, a price in `site.currency`: `<AddToCart id="concha" name="Concha" price={12} />`.',
		'Checkout opens WhatsApp with the order; the business confirms it and takes payment in the chat.'
	]
};
