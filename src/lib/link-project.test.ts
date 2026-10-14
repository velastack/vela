import { afterEach, describe, expect, test, vi } from 'vitest';
import { API_URL } from './constants.ts';
import { seedLinkedProject } from './link-project.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('seedLinkedProject', () => {
	test('posts the template and version and returns what was seeded', async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ status: 'seeded', locales: ['en', 'es'], layouts: 2, pages: 5, site: true })
		);
		vi.stubGlobal('fetch', fetchMock);

		const seed = await seedLinkedProject('key', 'p1', { name: 'hearth', version: 'abc1234' });
		expect(seed).toMatchObject({ status: 'seeded', locales: ['en', 'es'] });

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${API_URL}/v1/projects/p1/site/seed`);
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ template: 'hearth', version: 'abc1234' });
		expect(new Headers(init.headers).get('Authorization')).toBe('Bearer key');
	});

	test('passes already-seeded through', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ status: 'already-seeded' }))
		);
		expect(await seedLinkedProject('key', 'p1', { name: 'hearth' })).toEqual({
			status: 'already-seeded'
		});
	});

	test('turns an error into a failed report instead of throwing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('no template hearth', { status: 404 }))
		);
		expect(await seedLinkedProject('key', 'p1', { name: 'hearth' })).toEqual({
			status: 'failed',
			error: 'Velastack API error (404): no template hearth'
		});

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('fetch failed');
			})
		);
		expect(await seedLinkedProject('key', 'p1', { name: 'hearth' })).toEqual({
			status: 'failed',
			error: 'fetch failed'
		});
	});
});
