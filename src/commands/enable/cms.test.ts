import { describe, expect, test } from 'vitest';
import { resolveCmsBackend } from './cms.ts';

describe('resolveCmsBackend', () => {
	const none = { backend: false, adapter: 'auto' as const };

	test('--endpoint wins over everything', () => {
		expect(
			resolveCmsBackend({
				endpoint: 'https://cms.example.com',
				backend: true,
				adapter: 'node',
				projectId: 'p1'
			})
		).toEqual({ kind: 'hosted', endpoint: 'https://cms.example.com', from: 'flag' });
	});

	test('a server hosts it: a PocketBase backend, or adapter-node alone', () => {
		expect(resolveCmsBackend({ backend: true, adapter: 'static' })).toEqual({
			kind: 'self-hosted'
		});
		// A project vela did not create, after `vela deploy` put it on adapter-node.
		expect(resolveCmsBackend({ backend: false, adapter: 'node' })).toEqual({
			kind: 'self-hosted'
		});
		// Linked or not: every `vela create` project is linked.
		expect(resolveCmsBackend({ backend: true, adapter: 'node', projectId: 'p1' })).toEqual({
			kind: 'self-hosted'
		});
	});

	test("no server falls back to the linked project's hosted CMS", () => {
		const resolved = resolveCmsBackend({ ...none, projectId: 'p1' });
		expect(resolved).toMatchObject({ kind: 'hosted', from: 'link' });
		expect(resolved.kind === 'hosted' && resolved.endpoint).toMatch(/\/v1\/projects\/p1\/cms$/);
		expect(resolveCmsBackend({ backend: false, adapter: 'static', projectId: 'p1' })).toMatchObject(
			{ kind: 'hosted' }
		);
	});

	test('nothing to run it on', () => {
		expect(resolveCmsBackend(none)).toEqual({ kind: 'none' });
		expect(resolveCmsBackend({ backend: false, adapter: 'static' })).toEqual({ kind: 'none' });
	});
});
