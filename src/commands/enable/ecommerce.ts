import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import type { Provider } from '@velastack/patterns';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { assertPatternRequires } from '../../lib/require-features.ts';
import { isInteractive, resolveProvider } from '../../lib/providers.ts';
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
			// A WhatsApp item is whatever the page says it is: there is no id to demo.
			const demoId = provider.id === 'whatsapp' ? '' : await askDemoId(provider);

			await runPattern(
				'enable-ecommerce',
				cmd.args,
				{ provider: provider.id, demoId },
				{
					summary: `Enabled a ${provider.label} cart.`,
					nextSteps: [
						...(demoId ? ['Run `vela dev` and visit /shop to add the demo item to the cart.'] : []),
						'Put `<AddToCart>` (src/lib/components/cart/add-to-cart.svelte) on the pages that sell things.',
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

async function askDemoId(provider: Provider): Promise<string> {
	if (!isInteractive()) return '';
	const value = await p.text({
		message:
			provider.id === 'stripe'
				? 'Stripe price_id for a demo /shop page (price_...)'
				: 'Shopify product variant for a demo /shop page (gid://shopify/ProductVariant/...)',
		placeholder: 'leave blank to skip the demo page'
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return (value ?? '').trim();
}
