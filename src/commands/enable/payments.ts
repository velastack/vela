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
		'the currency the business prices in, an ISO 4217 code such as MXN (kept in src/lib/site.ts; WhatsApp needs it)'
	)
	.option(
		'--country <code>',
		'the country the business is in, ISO 3166-1 such as MX; prices format for it'
	)
	.option(
		'--currencies <codes>',
		'other currencies to show prices in, as estimates, comma-separated (USD,EUR); blank for none'
	)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action(
		(opts: { provider?: string; currency?: string; country?: string; currencies?: string }, cmd) =>
			runCommand(async () => {
				const provider = await resolveProvider('enable-payments', opts.provider);

				// Refuse before asking for keys: Stripe needs a backend and workflows.
				await assertPatternRequires('enable-payments', provider.id);
				if (provider.id === 'stripe') assertBackendReady('vela enable payments');

				if (provider.id === 'stripe') noteWebhookSecret();
				const business = await askBusiness(opts, provider.id === 'whatsapp');
				const orderForm = provider.id === 'whatsapp' ? await prepareOrderForm() : [];
				const providerEnv = await collectProviderEnv(provider);
				const demoId = provider.id === 'whatsapp' ? '' : await askDemoId(provider);
				// The order form's note already says how to fill it in.
				const blank = missingEnvKeys(provider, providerEnv).filter(
					(key) => !(key === 'PUBLIC_WHATSAPP_ORDER_FORM' && orderForm.length > 0)
				);

				await runPattern(
					'enable-payments',
					cmd.args,
					{ provider: provider.id, providerEnv, demoId, ...business },
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

/** Whether `code` is a region `Intl` knows. */
function isCountry(code: string): boolean {
	const upper = code.trim().toUpperCase();
	return (
		/^[A-Z]{2}$/.test(upper) &&
		new Intl.DisplayNames(['en'], { type: 'region' }).of(upper) !== upper
	);
}

/** What `src/lib/site.ts` already declares about the business. */
function declaredBusiness(): { currency?: string; country?: string; currencies?: string } {
	const root = findWorkspaceRoot();
	const site = root ? path.join(root, 'src', 'lib', 'site.ts') : null;
	if (!site || !fs.existsSync(site)) return {};
	const source = fs.readFileSync(site, 'utf8');
	return {
		currency: /^\s*currency\s*:\s*['"]([A-Za-z]{3})['"]/m.exec(source)?.[1],
		country: /^\s*country\s*:\s*['"]([A-Za-z]{2})['"]/m.exec(source)?.[1],
		currencies: /^\s*currencies\s*:\s*\[([^\]]*)\]/m.exec(source)?.[1]
	};
}

type Business = { currency?: string; country?: string; currencies?: string };

/**
 * What the business declares in `src/lib/site.ts`: the currency it prices in,
 * the country it is in (prices format for it: `es-MX`, not `es`), and the
 * other currencies it shows prices in. Flags first, then what the file already
 * says (the pattern keeps that), then a prompt. WhatsApp cannot take orders
 * without a currency; the others can run without one, so off a terminal they
 * ask for nothing.
 */
async function askBusiness(flags: Business, currencyRequired: boolean): Promise<Business> {
	const declared = declaredBusiness();
	const business: Business = {
		currency: flags.currency?.trim().toUpperCase(),
		country: flags.country?.trim().toUpperCase(),
		currencies: flags.currencies
	};
	const ask = isInteractive();

	if (!business.currency && !declared.currency) {
		if (!ask) return business;
		business.currency = await text({
			message: 'The currency the business prices in (ISO 4217)',
			placeholder: 'MXN, EUR, USD...',
			validate: (value) =>
				value && isCurrency(value)
					? undefined
					: currencyRequired || value
						? 'An ISO 4217 code, such as MXN or EUR'
						: undefined
		});
	}
	const home = (business.currency ?? declared.currency ?? '').toUpperCase();

	if (!business.country && !declared.country && ask) {
		business.country = await text({
			message: 'The country the business is in (ISO 3166-1, two letters), so prices format for it',
			placeholder: 'MX, ES, US...',
			validate: (value) =>
				!value || isCountry(value) ? undefined : 'A two-letter country code, such as MX'
		});
	}

	if (business.currencies === undefined && declared.currencies === undefined && ask && home) {
		business.currencies = await text({
			message: `Other currencies to show prices in, as estimates (comma-separated, blank for ${home} only)`,
			placeholder: 'USD, EUR',
			validate: (value) =>
				value && value.split(/[,\s]+/).some((code) => code && !isCurrency(code))
					? 'ISO 4217 codes, comma-separated'
					: undefined
		});
	}
	return {
		currency: business.currency?.toUpperCase() || undefined,
		country: business.country?.toUpperCase() || undefined,
		currencies: business.currencies ?? undefined
	};
}

async function text(options: Parameters<typeof p.text>[0]): Promise<string | undefined> {
	const value = await p.text(options);
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return (value ?? '').trim() || undefined;
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
