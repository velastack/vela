import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./config.ts', () => ({
	requireApiKey: () => 'k1.s2'
}));

vi.mock('./project-config.ts', () => ({
	readProjectConfig: () => ({ projectId: 'p1', teamId: 't1', projectName: 'demo' })
}));

import { aiSchema, aiForm } from './ai-client.ts';

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
	global.fetch = vi.fn(impl as typeof fetch);
}

describe('aiSchema', () => {
	beforeEach(() => {
		mockFetch(async () =>
			new Response(JSON.stringify({ result: { name: 'x', type: 'base', fields: [] }, turn: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
	});

	it('hits /v1/projects/<id>/ai/schema with Bearer token', async () => {
		const out = await aiSchema('/cwd', { prompt: 'hi' });
		expect(out.result.name).toBe('x');
		const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(call[0]).toBe('https://velastack.dev/v1/projects/p1/ai/schema');
		expect(call[1]).toMatchObject({
			method: 'POST',
			headers: expect.objectContaining({ Authorization: 'Bearer k1.s2' })
		});
		expect(JSON.parse(call[1].body as string)).toEqual({ prompt: 'hi' });
	});
});

describe('aiForm', () => {
	it('hits /v1/projects/<id>/ai/form', async () => {
		mockFetch(async () =>
			new Response(JSON.stringify({ result: { rows: [] }, turn: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		await aiForm('/cwd', { context: { model: { name: 'x', type: 'base', fields: [] } } });
		const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(call[0]).toBe('https://velastack.dev/v1/projects/p1/ai/form');
	});
});

describe('error mapping', () => {
	it('401 → API key invalid', async () => {
		mockFetch(async () => new Response('forbidden', { status: 401 }));
		await expect(aiSchema('/cwd', { prompt: 'hi' })).rejects.toThrow(/API key invalid/);
	});

	it('403 → API key invalid', async () => {
		mockFetch(async () => new Response('no', { status: 403 }));
		await expect(aiSchema('/cwd', { prompt: 'hi' })).rejects.toThrow(/API key invalid/);
	});

	it('502 → AI request failed', async () => {
		mockFetch(async () => new Response('LLM output failed validation: …', { status: 502 }));
		await expect(aiSchema('/cwd', { prompt: 'hi' })).rejects.toThrow(/AI request failed/);
	});

	it('500 → Velastack API error', async () => {
		mockFetch(async () => new Response('boom', { status: 500 }));
		await expect(aiSchema('/cwd', { prompt: 'hi' })).rejects.toThrow(/Velastack API error \(500\)/);
	});
});
