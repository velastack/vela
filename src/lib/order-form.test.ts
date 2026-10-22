import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { API_URL } from './constants.ts';
import { ensureOrderForm, hostedCmsProject, orderFormUrl } from './order-form.ts';
import { ApiError } from './velastack-api.ts';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-order-form-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const write = (file: string, content: string) => {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), content);
};

const link = (projectId = 'p1linked') =>
	write('.vela/project.json', JSON.stringify({ projectId, teamId: 't1', projectName: 'Bakery' }));

const hostedCms = (endpoint: string) =>
	write(
		'src/lib/cms.ts',
		`export const { load: loadCms } = createCms({\n\tadapter: apiAdapter({ endpoint: '${endpoint}' }),\n});\n`
	);

describe('hostedCmsProject', () => {
	test('reads the project from a hosted endpoint', () => {
		hostedCms('https://velastack.dev/v1/projects/abc123/cms');
		expect(hostedCmsProject(root)).toEqual({
			origin: 'https://velastack.dev',
			projectId: 'abc123'
		});
	});

	test('finds nothing for a local CMS or no CMS', () => {
		expect(hostedCmsProject(root)).toBeNull();
		hostedCms('/api/cms');
		expect(hostedCmsProject(root)).toBeNull();
	});
});

describe('ensureOrderForm', () => {
	const deps = (apiKey: string | null = 'vk_test') => ({
		readApiKey: () => apiKey,
		createForms: vi.fn(async () => ({ created: ['order'], existing: [] }))
	});

	test('creates the form on the linked project', async () => {
		link();
		const d = deps();
		expect(await ensureOrderForm(root, d)).toEqual({
			kind: 'created',
			url: orderFormUrl(API_URL, 'p1linked')
		});
		expect(d.createForms).toHaveBeenCalledWith('vk_test', 'p1linked', [
			{ key: 'order', name: 'Orders' }
		]);
	});

	test("falls back to the hosted CMS's project, on its origin", async () => {
		hostedCms('https://cms.example.com/v1/projects/abc123/cms');
		expect(await ensureOrderForm(root, deps())).toEqual({
			kind: 'created',
			url: 'https://cms.example.com/v1/projects/abc123/forms/order'
		});
	});

	test('says what to do without a project or a login', async () => {
		expect(await ensureOrderForm(root, deps())).toMatchObject({
			kind: 'skipped',
			note: expect.stringContaining('vela link')
		});
		link();
		expect(await ensureOrderForm(root, deps(null))).toMatchObject({
			kind: 'skipped',
			note: expect.stringContaining('vela login')
		});
	});

	test('names the URL to set when velastack.dev refuses', async () => {
		link();
		const d = deps();
		d.createForms.mockRejectedValueOnce(new ApiError(404, 'Not found'));
		const outcome = await ensureOrderForm(root, d);
		expect(outcome).toMatchObject({ kind: 'skipped' });
		expect(outcome.kind === 'skipped' && outcome.note).toContain('answered 404');
		expect(outcome.kind === 'skipped' && outcome.note).toContain(
			`PUBLIC_WHATSAPP_ORDER_FORM=${orderFormUrl(API_URL, 'p1linked')}`
		);
	});
});
