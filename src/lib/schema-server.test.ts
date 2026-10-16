import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionsClient, PocketBaseCollection } from '@velastack/schema';
import { startSchemaServer, TOKEN_HEADER, type SchemaServer } from './schema-server.ts';

/** An in-memory stand-in for PocketBase's collections API that writes migration files. */
const fakePocketBase = (migrationsDir: string) => {
	const collections: PocketBaseCollection[] = [
		{
			id: '_pb_users_auth_',
			name: 'users',
			type: 'auth',
			fields: [{ id: 'text3208210256', name: 'id', type: 'text', system: true }],
			indexes: []
		}
	];
	let stamp = 1_700_000_000;
	const write = (verb: string, name: string) => {
		stamp += 1;
		fs.writeFileSync(path.join(migrationsDir, `${stamp}_${verb}_${name}.js`), '');
	};
	const client: CollectionsClient = {
		list: async () => structuredClone(collections),
		create: async (body) => {
			if (body.name === 'refused') throw new Error('nope');
			collections.push(structuredClone(body));
			write('created', body.name);
			return body;
		},
		update: async (id, body) => {
			const index = collections.findIndex((c) => c.id === id);
			collections[index] = structuredClone(body);
			write('updated', body.name);
			return body;
		},
		delete: async (id) => {
			const index = collections.findIndex((c) => c.id === id);
			write('deleted', collections[index]!.name);
			collections.splice(index, 1);
		}
	};
	return { client, collections };
};

let dir: string;
let appDir: string;
let server: SchemaServer;
let fake: ReturnType<typeof fakePocketBase>;
let applied: string[][] = [];

beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-server-'));
	appDir = path.join(dir, 'app');
	fs.mkdirSync(appDir);
	fs.writeFileSync(path.join(appDir, 'index.html'), '<!doctype html><title>editor</title>');
	fs.mkdirSync(path.join(appDir, '_app'));
	fs.writeFileSync(path.join(appDir, '_app', 'main.js'), 'console.log(1)');
	const migrationsDir = path.join(dir, 'migrations');
	fs.mkdirSync(migrationsDir);
	fake = fakePocketBase(migrationsDir);
	applied = [];
	server = await startSchemaServer({
		client: fake.client,
		migrationsDir,
		appDir,
		project: 'demo',
		onApplied: (written) => applied.push(written)
	});
});

afterEach(async () => {
	await server.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

const origin = () => `http://127.0.0.1:${server.port}`;
const api = (path: string, init: RequestInit = {}, token = server.token) =>
	fetch(`${origin()}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token, ...(init.headers ?? {}) }
	});

describe('schema server', () => {
	it('opens with the token in the URL fragment, never in the path', () => {
		expect(server.url).toBe(`http://127.0.0.1:${server.port}/#token=${server.token}`);
		expect(server.token).toMatch(/^[0-9a-f]{32}$/);
	});

	it('serves the editor shell and its assets, and falls back to the shell for app routes', async () => {
		expect(await (await fetch(`${origin()}/`)).text()).toContain('editor');
		const asset = await fetch(`${origin()}/_app/main.js`);
		expect(asset.headers.get('content-type')).toContain('javascript');
		expect(await (await fetch(`${origin()}/some/route`)).text()).toContain('editor');
		expect((await fetch(`${origin()}/../package.json`)).status).toBe(200); // normalised to the shell
	});

	it('refuses a request whose Host is not its own', async () => {
		// fetch refuses to send a custom Host header, so this goes through http directly.
		const status = await new Promise<number>((resolve, reject) => {
			const request = http.request(
				{
					host: '127.0.0.1',
					port: server.port,
					path: '/api/schema',
					headers: { host: 'evil.example:80', [TOKEN_HEADER]: server.token }
				},
				(response) => {
					response.resume();
					resolve(response.statusCode ?? 0);
				}
			);
			request.on('error', reject);
			request.end();
		});
		expect(status).toBe(403);
	});

	it('refuses /api without the token', async () => {
		expect((await fetch(`${origin()}/api/schema`)).status).toBe(401);
		expect((await api('/api/schema', {}, 'wrong')).status).toBe(401);
	});

	it('reads the schema', async () => {
		const response = await api('/api/schema');
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			base: { collections: { name: string }[] };
			project: string;
		};
		expect(body.project).toBe('demo');
		expect(body.base.collections.map((c) => c.name)).toEqual(['users']);
	});

	it('plans from next itself, applies, and reports the files written', async () => {
		const { base } = (await (await api('/api/schema')).json()) as {
			base: { collections: unknown[] };
		};
		const next = {
			collections: [
				...base.collections,
				{
					id: 'pbc_posts000001',
					name: 'posts',
					type: 'base',
					indexes: [],
					rules: { list: null, view: null, create: null, update: null, delete: null },
					fields: [
						{ id: 'text_title', name: 'title', type: 'text' },
						{
							id: 'relation_author',
							name: 'author',
							type: 'relation',
							collectionId: '_pb_users_auth_',
							maxSelect: 1
						},
						{
							id: 'relation_parent',
							name: 'parent',
							type: 'relation',
							collectionId: 'pbc_posts000001',
							maxSelect: 1
						}
					]
				}
			]
		};
		const response = await api('/api/apply', { method: 'POST', body: JSON.stringify({ next }) });
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			applied: { phase: number; kind: string; name: string }[];
			written: string[];
			base: { collections: { name: string; fields: { name: string }[] }[] };
			failed?: unknown;
		};
		expect(body.failed).toBeUndefined();
		expect(body.applied).toEqual([
			{ phase: 3, kind: 'create', name: 'posts' },
			{ phase: 4, kind: 'update', name: 'posts' }
		]);
		expect(body.written).toHaveLength(2);
		expect(body.written[0]).toMatch(/_created_posts\.js$/);
		expect(applied).toEqual([body.written]);
		// The server completed the collection with the system id field.
		expect(body.base.collections.find((c) => c.name === 'posts')!.fields[0]!.name).toBe('id');
	});

	it('refuses a next with lint errors and applies nothing', async () => {
		const next = {
			collections: [
				{
					id: 'pbc_bad',
					name: 'bad name',
					type: 'base',
					indexes: [],
					rules: { list: null, view: null, create: null, update: null, delete: null },
					fields: []
				}
			]
		};
		const response = await api('/api/apply', { method: 'POST', body: JSON.stringify({ next }) });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { issues: { code: string }[] };
		expect(body.issues.map((i) => i.code)).toContain('collection-name');
		expect(fake.collections.map((c) => c.name)).toEqual(['users']);
	});

	it('reports a refused step without losing the ones before it', async () => {
		const { base } = (await (await api('/api/schema')).json()) as {
			base: { collections: unknown[] };
		};
		const shape = (id: string, name: string) => ({
			id,
			name,
			type: 'base',
			indexes: [],
			rules: { list: null, view: null, create: null, update: null, delete: null },
			fields: [{ id: `text_${name}`, name: 'title', type: 'text' }]
		});
		const next = {
			collections: [...base.collections, shape('pbc_ok', 'ok'), shape('pbc_refused', 'refused')]
		};
		const body = (await (
			await api('/api/apply', { method: 'POST', body: JSON.stringify({ next }) })
		).json()) as {
			applied: { name: string }[];
			failed?: { step: { name: string }; message: string };
		};
		expect(body.applied.map((s) => s.name)).toEqual(['ok']);
		expect(body.failed).toEqual({
			step: { phase: 3, kind: 'create', name: 'refused' },
			message: 'nope'
		});
	});
});
