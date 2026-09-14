import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	INDEX_CACHE_TTL_MS,
	downloadTemplate,
	fetchTemplateIndex,
	parseTemplateIndex,
	resolveDownloadUrl,
	type RemoteTemplateEntry
} from './template-registry.ts';
import { copyTemplate, listAllTemplates, resolveTemplate } from './templates.ts';
import { applyTemplateFiles } from './template-files.ts';

let tmp: string;
let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;
let registryDir: string;
let indexUrl: string;
let entry: RemoteTemplateEntry;

/** A registry with one template, `sample`, laid out the way `pack.ts` publishes it. */
async function buildRegistry() {
	registryDir = path.join(tmp, 'registry');
	const source = path.join(tmp, 'source', 'sample');
	fs.mkdirSync(path.join(source, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(source, 'template.json'),
		JSON.stringify({ description: 'A sample', backend: true, category: 'blog' })
	);
	fs.writeFileSync(
		path.join(source, 'package.template.json'),
		JSON.stringify({ name: '~TODO~', devDependencies: { vela: '^~VELA_VERSION~' } })
	);
	fs.writeFileSync(path.join(source, '_gitignore'), 'node_modules\n');
	fs.writeFileSync(path.join(source, 'src', 'app.html'), '<html></html>');

	fs.mkdirSync(registryDir, { recursive: true });
	const file = path.join(registryDir, 'sample.tgz');
	await tar.create({ gzip: true, file, cwd: path.join(tmp, 'source'), portable: true }, ['sample']);
	const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');

	entry = {
		name: 'sample',
		title: 'Sample',
		description: 'A sample',
		backend: true,
		category: 'blog',
		tags: ['blog'],
		price: 0,
		file: 'sample.tgz',
		sha256
	};
	writeIndex([entry, { name: 'broken' }]);
	indexUrl = pathToFileURL(path.join(registryDir, 'index.json')).href;
}

function writeIndex(templates: unknown[]) {
	fs.writeFileSync(
		path.join(registryDir, 'index.json'),
		JSON.stringify({ schemaVersion: 1, templates })
	);
}

beforeEach(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-registry-'));
	tmpHome = path.join(tmp, 'home');
	fs.mkdirSync(tmpHome);
	origHome = process.env.HOME;
	origUserProfile = process.env.USERPROFILE;
	process.env.HOME = tmpHome;
	process.env.USERPROFILE = tmpHome;
	await buildRegistry();
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	if (origUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = origUserProfile;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const cacheDir = () => path.join(tmpHome, '.vela', 'templates');

describe('parseTemplateIndex', () => {
	test('keeps valid entries and counts the rest', () => {
		const text = fs.readFileSync(path.join(registryDir, 'index.json'), 'utf8');
		const index = parseTemplateIndex(text, indexUrl);
		expect(index.templates.map((t) => t.name)).toEqual(['sample']);
		expect(index.skipped).toBe(1);
	});

	test('keeps the cms and instantDeploy flags a newer registry publishes', () => {
		const text = JSON.stringify({
			schemaVersion: 1,
			templates: [{ ...entry, cms: true, instantDeploy: true, futureField: 1 }]
		});
		const [parsed] = parseTemplateIndex(text, indexUrl).templates;
		expect(parsed).toMatchObject({ name: 'sample', cms: true, instantDeploy: true });
		expect(parsed).not.toHaveProperty('futureField');
	});

	test('rejects an index this CLI cannot read', () => {
		expect(() => parseTemplateIndex('{"schemaVersion":2,"templates":[]}', 'x')).toThrow(
			'unsupported format'
		);
		expect(() => parseTemplateIndex('nope', 'x')).toThrow('not valid JSON');
	});
});

describe('fetchTemplateIndex', () => {
	test('reads a file: index without touching the cache', async () => {
		const result = await fetchTemplateIndex(indexUrl);
		expect(result.index?.templates[0]?.name).toBe('sample');
		expect(result.stale).toBe(false);
		expect(fs.existsSync(path.join(cacheDir(), 'index.json'))).toBe(false);
	});

	test('caches an http index and serves it while fresh', async () => {
		const text = fs.readFileSync(path.join(registryDir, 'index.json'), 'utf8');
		const fetchMock = vi.fn(async () => new Response(text, { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const first = await fetchTemplateIndex('https://example.test/index.json', { now: 1000 });
		expect(first.index?.templates).toHaveLength(1);
		expect(fs.existsSync(path.join(cacheDir(), 'index.json'))).toBe(true);

		const second = await fetchTemplateIndex('https://example.test/index.json', { now: 2000 });
		expect(second.index?.templates).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await fetchTemplateIndex('https://example.test/index.json', {
			now: 1000 + INDEX_CACHE_TTL_MS + 1
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test('falls back to a stale cache when the registry is unreachable', async () => {
		const text = fs.readFileSync(path.join(registryDir, 'index.json'), 'utf8');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(text, { status: 200 }))
		);
		await fetchTemplateIndex('https://example.test/index.json', { now: 1000 });

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Promise.reject(new Error('offline')))
		);
		const result = await fetchTemplateIndex('https://example.test/index.json', {
			now: 1000 + INDEX_CACHE_TTL_MS + 1
		});
		expect(result.stale).toBe(true);
		expect(result.reason).toBe('offline');
		expect(result.index?.templates[0]?.name).toBe('sample');
	});

	test('reports the failure when nothing is cached', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 503 }))
		);
		const result = await fetchTemplateIndex('https://example.test/index.json');
		expect(result.index).toBeNull();
		expect(result.reason).toContain('503');
	});
});

describe('resolveDownloadUrl', () => {
	test('resolves the tarball relative to the index', () => {
		expect(resolveDownloadUrl(entry, 'https://templates.example/index.json')).toBe(
			'https://templates.example/sample.tgz'
		);
	});
});

describe('downloadTemplate', () => {
	test('unpacks the archive into a template-shaped directory and caches the tarball', async () => {
		const dir = await downloadTemplate(entry, indexUrl);
		try {
			expect(fs.existsSync(path.join(dir, 'template.json'))).toBe(true);
			expect(fs.existsSync(path.join(dir, 'package.template.json'))).toBe(true);
			expect(fs.existsSync(path.join(dir, 'src', 'app.html'))).toBe(true);
			expect(
				fs.existsSync(path.join(cacheDir(), 'cache', `sample-${entry.sha256.slice(0, 12)}.tgz`))
			).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('refuses a tarball whose checksum does not match', async () => {
		const tampered = { ...entry, sha256: 'f'.repeat(64) };
		await expect(downloadTemplate(tampered, indexUrl)).rejects.toThrow(
			'did not match its checksum'
		);
	});

	test('reuses a cached tarball instead of fetching again', async () => {
		const first = await downloadTemplate(entry, indexUrl);
		fs.rmSync(first, { recursive: true, force: true });
		fs.rmSync(path.join(registryDir, 'sample.tgz'));

		const second = await downloadTemplate(entry, indexUrl);
		expect(fs.existsSync(path.join(second, 'template.json'))).toBe(true);
		fs.rmSync(second, { recursive: true, force: true });
	});
});

describe('listAllTemplates', () => {
	test('lists built-ins first, then registry templates by category', async () => {
		writeIndex([entry, { ...entry, name: 'minimal', category: 'blog' }]);
		const listing = await listAllTemplates({ indexUrl });
		expect(listing.registryError).toBeUndefined();
		expect(listing.templates.map((t) => `${t.source}:${t.name}`)).toEqual([
			'builtin:minimal',
			'builtin:static',
			'remote:sample'
		]);
		const sample = listing.templates.find((t) => t.name === 'sample');
		expect(sample?.category).toBe('blog');
		expect(sample?.title).toBe('Sample');
	});

	test('keeps the built-ins and explains when the registry is unreachable', async () => {
		const listing = await listAllTemplates({
			indexUrl: pathToFileURL(path.join(tmp, 'missing.json')).href
		});
		expect(listing.templates.map((t) => t.name)).toEqual(['minimal', 'static']);
		expect(listing.registryError).toContain('ENOENT');
	});
});

describe('resolveTemplate', () => {
	test('a downloaded template goes through the same copy step as a built-in', async () => {
		const listing = await listAllTemplates({ indexUrl });
		const sample = listing.templates.find((t) => t.name === 'sample')!;
		const resolved = await resolveTemplate(sample);
		const project = path.join(tmp, 'project');
		try {
			copyTemplate(resolved, project);
			const written = applyTemplateFiles(project, { appName: 'My Blog', cliVersion: '9.9.9' });
			expect(written).toEqual(['package.json']);
		} finally {
			resolved.cleanup();
		}
		expect(fs.existsSync(resolved.dir)).toBe(false);
		expect(fs.existsSync(path.join(project, 'template.json'))).toBe(false);
		expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(true);
		expect(JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'))).toEqual({
			name: 'my-blog',
			devDependencies: { vela: '^9.9.9' }
		});
	});

	test('a built-in needs no cleanup', async () => {
		const listing = await listAllTemplates({ indexUrl });
		const minimal = listing.templates.find((t) => t.name === 'minimal')!;
		const resolved = await resolveTemplate(minimal);
		resolved.cleanup();
		expect(fs.existsSync(resolved.dir)).toBe(true);
	});
});
