import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import type { Provider } from '@velastack/patterns';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { assertBackendReady } from '../../lib/backend-gate.ts';
import { assertPatternRequires } from '../../lib/require-features.ts';
import { ensureOrderForm } from '../../lib/order-form.ts';
import { findWorkspaceRoot } from '../../lib/workspace.ts';
import {
	collectProviderEnv,
	isInteractive,
	missingEnvKeys,
	resolveProvider
} from '../../lib/providers.ts';

export const payments = new Command('payments')
	.description('enable payments (Stripe, Shopify or WhatsApp)')
	.option('--provider <provider>', 'payment provider: stripe, shopify or whatsapp')
	.option(
		'--currency <code>',
		"WhatsApp: the business's currency, an ISO 4217 code such as MXN (kept in src/lib/site.ts)"
	)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts: { provider?: string; currency?: string }, cmd) =>
		runCommand(async () => {
			const provider = await resolveProvider('enable-payments', opts.provider);

			// Refuse before asking for keys: Stripe needs a backend and workflows.
			await assertPatternRequires('enable-payments', provider.id);
			if (provider.id === 'stripe') assertBackendReady('vela enable payments');

			if (provider.id === 'stripe') noteWebhookSecret();
			const currency = provider.id === 'whatsapp' ? await askCurrency(opts.currency) : undefined;
			const orderForm = provider.id === 'whatsapp' ? await prepareOrderForm() : [];
			const providerEnv = await collectProviderEnv(provider);
			const demoId = provider.id === 'whatsapp' ? '' : await askDemoId(provider);
			const blank = missingEnvKeys(provider, providerEnv);

			await runPattern(
				'enable-payments',
				cmd.args,
				{ provider: provider.id, providerEnv, demoId, currency },
				{
					summary: `Enabled ${provider.label} payments.`,
					nextSteps: [
						...blank.map((key) => `Set ${key} in .env.`),
						...orderForm,
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
	],
	whatsapp: [
		'Put `<OrderButton name="..." price={...} />` (src/lib/components/payments/order-button.svelte) on the pages that sell things; prices are in `site.currency` (src/lib/site.ts).',
		'Edit the message the business receives in src/lib/order.ts.',
		"Orders recorded to the hosted form are on velastack.dev, under the project's forms."
	]
};

/** Whether `code` is a currency `Intl` knows (any well-formed code would format). */
function isCurrency(code: string): boolean {
	return Intl.supportedValuesOf('currency').includes(code.trim().toUpperCase());
}

/**
 * The business's currency for WhatsApp prices: the flag, else what
 * `src/lib/site.ts` already says (the pattern keeps it), else asked for.
 * Off a terminal with neither, the pattern says what to pass.
 */
async function askCurrency(flag: string | undefined): Promise<string | undefined> {
	if (flag) return flag.trim().toUpperCase();
	const root = findWorkspaceRoot();
	const site = root ? path.join(root, 'src', 'lib', 'site.ts') : null;
	if (site && fs.existsSync(site) && /^\s*currency\s*:/m.test(fs.readFileSync(site, 'utf8'))) {
		return undefined;
	}
	if (!isInteractive()) return undefined;
	const value = await p.text({
		message: "The business's currency, which every price is in (ISO 4217)",
		placeholder: 'MXN, EUR, USD...',
		validate: (value) =>
			value && isCurrency(value) ? undefined : 'An ISO 4217 code, such as MXN or EUR'
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value.trim().toUpperCase();
}

/**
 * Creates the hosted order form and puts its URL where `collectProviderEnv`
 * finds it, so it is not asked for. Returns the next step when it could not.
 */
async function prepareOrderForm(): Promise<string[]> {
	if (process.env.PUBLIC_WHATSAPP_ORDER_FORM) return [];
	const root = findWorkspaceRoot();
	if (!root) return [];
	const outcome = await ensureOrderForm(root);
	if (outcome.kind === 'created') {
		process.env.PUBLIC_WHATSAPP_ORDER_FORM = outcome.url;
		return outcome.note ? [outcome.note] : [];
	}
	// Asked for below, blank allowed; the note says how to get one later.
	return [outcome.note];
}

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
