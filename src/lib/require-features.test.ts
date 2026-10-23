import { describe, expect, test } from 'vitest';
import { blockedMessage, unmetMessage } from './require-features.ts';

describe('unmetMessage', () => {
	test('names each missing feature and the commands that add them, in order', () => {
		expect(
			unmetMessage('vela enable subscriptions', [
				{ kind: 'feature', feature: 'auth' },
				{ kind: 'feature', feature: 'payments' }
			])
		).toBe(
			[
				'`vela enable subscriptions` needs auth, payments, and this project does not have them.',
				'',
				'Nothing was changed. To set it up:',
				'  1. vela enable auth',
				'  2. vela enable payments',
				'Then run this again.'
			].join('\n')
		);
	});

	test('explains a provider mismatch, with how to switch', () => {
		const message = unmetMessage('vela enable subscriptions', [
			{ kind: 'provider', capability: 'payments', want: ['stripe'], have: 'shopify' }
		]);
		expect(message).toContain('needs Stripe payments');
		expect(message).toContain('This project uses Shopify payments.');
		expect(message).toContain(
			'`vela disable payments`, then `vela enable payments --provider stripe`'
		);
		expect(message).not.toContain('To set it up');
	});

	test('asks for a provider that is missing outright', () => {
		expect(
			unmetMessage('vela enable ecommerce', [
				{ kind: 'provider', capability: 'payments', want: ['stripe', 'shopify'], have: null }
			])
		).toContain('  1. vela enable payments --provider stripe');
	});

	test('says why an ambiguous provider is refused', () => {
		const message = unmetMessage('vela enable ecommerce', [
			{ kind: 'ambiguous', capability: 'payments', ids: ['stripe', 'shopify'] }
		]);
		expect(message).toContain('needs one payments provider');
		expect(message).toContain('the settings of Stripe or Shopify payments');
	});
});

describe('blockedMessage', () => {
	test('names what depends on the pattern and the disable to run first', () => {
		expect(blockedMessage('vela disable payments', ['ecommerce'])).toBe(
			[
				"`vela disable payments` can't run while this project has ecommerce: it depends on what it removes.",
				'',
				'Nothing was changed. To take it out first:',
				'  1. vela disable ecommerce',
				'Then run this again.'
			].join('\n')
		);
	});
});
