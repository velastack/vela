import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

type Provider = 'stripe';

const PROVIDERS: Array<{ value: Provider; label: string }> = [{ value: 'stripe', label: 'Stripe' }];

export const payments = new Command('payments')
	.description('enable payments')
	.option('--provider <provider>', 'payment provider', 'stripe')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(async () => {
			const provider = await resolveProvider(opts.provider, cmd.getOptionValueSource('provider'));

			const input = {
				provider,
				stripeSecretKey: await ensureKey('STRIPE_SECRET_KEY', 'Stripe secret key (sk_...)'),
				stripePublishableKey: await ensureKey(
					'PUBLIC_STRIPE_PUBLISHABLE_KEY',
					'Stripe publishable key (pk_...)'
				),
				stripeWebhookSecret: await ensureWebhookSecret(),
				stripePriceId: await ensurePriceId()
			};
			await runPattern('enable-payments', cmd.args, input, {
				summary: 'Enabled Stripe payments.',
				nextSteps: [
					'Forward Stripe webhooks locally with `stripe listen --forward-to localhost:5173/webhooks/stripe`.',
					'Run `vela dev` and visit /payment to run through the checkout flow.',
					'Add products and prices in the Stripe dashboard.'
				],
				task: {
					title: 'Enabling payments',
					success: 'Enabled payments',
					error: 'Failed to enable payments'
				}
			});
		}, 'Failed to enable payments.')
	);

async function resolveProvider(value: string, source: string | undefined): Promise<Provider> {
	if (source && source !== 'default') {
		if (!PROVIDERS.some((o) => o.value === value)) {
			throw new Error(`Unknown payment provider: ${value}`);
		}
		return value as Provider;
	}

	const selected = await p.select<Provider>({
		message: 'Which payment provider?',
		options: PROVIDERS,
		initialValue: 'stripe'
	});
	if (p.isCancel(selected)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return selected;
}

async function ensureWebhookSecret(): Promise<string> {
	const existing = process.env.STRIPE_WEBHOOK_SECRET;
	if (existing) return existing;

	p.note(
		[
			'Download the Stripe CLI (https://stripe.com/docs/stripe-cli), then run:',
			'  stripe listen --forward-to localhost:5173/webhooks/stripe',
			'Copy the whsec_... value it prints and paste it below.'
		].join('\n'),
		'Stripe webhook signing secret',
		{ format: (line) => line }
	);

	return promptPassword('Stripe webhook signing secret (whsec_...)');
}

async function ensurePriceId(): Promise<string> {
	p.note(
		[
			'Stripe checkout requires a product and price_id.',
			'If you have a demo product price_id, enter it below, or leave blank to create a demo one for you.'
		].join('\n'),
		'Stripe demo product',
		{ format: (line) => line }
	);

	const value = await p.text({
		message: 'Stripe price_id (price_...)',
		placeholder: 'leave blank to create a demo product'
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return (value ?? '').trim();
}

async function ensureKey(envVar: string, message: string): Promise<string> {
	const existing = process.env[envVar];
	if (existing) return existing;
	return promptPassword(message);
}

async function promptPassword(message: string): Promise<string> {
	const value = await p.password({
		message,
		validate: (v) => (v && v.length ? undefined : 'Required')
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value;
}
