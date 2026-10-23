import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { assertBackendReady } from '../../lib/backend-gate.ts';
import { assertPatternRequires } from '../../lib/require-features.ts';
import { resolveProvider } from '../../lib/providers.ts';
import { detectWorkspace } from '../../lib/workspace.ts';

export const shop = new Command('shop')
	.description("generate a product listing and product pages for the project's cart")
	.option('--provider <provider>', 'must match the payments provider: stripe, shopify or whatsapp')
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts: { provider?: string }, cmd) =>
		runCommand(async () => {
			// The shop follows the cart, which follows payments.
			const { detected } = await detectWorkspace();
			const provider = await resolveProvider('generate-shop', opts.provider, detected.providers);
			await assertPatternRequires('generate-shop', provider.id);
			// Stripe's pages read the synced catalog from PocketBase on the server.
			if (provider.id === 'stripe') assertBackendReady('vela generate shop');

			await runPattern(
				'generate-shop',
				cmd.args,
				{ provider: provider.id },
				{
					summary: `Generated a ${provider.label} shop.`,
					nextSteps: [
						'Run `vela dev` and visit /shop.',
						...NEXT_STEPS[provider.id],
						'The pages are yours to edit; `vela destroy shop` removes them.'
					],
					task: {
						title: 'Generating the shop',
						success: 'Generated the shop',
						error: 'Failed to generate the shop'
					}
				}
			);
		}, 'Failed to generate the shop.')
	);

const NEXT_STEPS: Record<string, string[]> = {
	stripe: [
		'Products and prices come from your Stripe dashboard; the catalog syncs every ten minutes. Set `metadata.slug` on a product for a readable URL.'
	],
	shopify: [
		'Products live in Shopify admin; publish them to the Headless channel the Storefront token belongs to.'
	],
	whatsapp: [
		'Edit the products in src/lib/catalog.ts; prices are in `site.currency` (src/lib/site.ts). With the CMS, open /shop with `?edit` instead.'
	]
};
