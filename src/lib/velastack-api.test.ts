import { afterEach, describe, expect, test, vi } from 'vitest';
import { purchaseTemplate } from './velastack-api.ts';

afterEach(() => vi.unstubAllGlobals());

describe('purchaseTemplate', () => {
	test('posts the team to the purchase endpoint with the API key', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ status: 'purchased', amount: 1800, currency: 'usd' }), {
					status: 200
				})
		);
		vi.stubGlobal('fetch', fetchMock);

		const outcome = await purchaseTemplate('key.secret', 'claret', 'team123');
		expect(outcome).toEqual({ status: 'purchased', amount: 1800, currency: 'usd' });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://velastack.dev/v1/templates/claret/purchase');
		expect(init.method).toBe('POST');
		expect(init.body).toBe(JSON.stringify({ team: 'team123' }));
		expect(new Headers(init.headers).get('authorization')).toBe('Bearer key.secret');
	});

	test('surfaces what velastack.dev refused', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({ error: 'Only the owner can buy templates for this team' }),
						{
							status: 403
						}
					)
			)
		);
		await expect(purchaseTemplate('key.secret', 'claret', 'team123')).rejects.toThrow(
			'Only the owner can buy templates'
		);
	});
});
