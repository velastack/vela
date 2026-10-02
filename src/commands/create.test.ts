import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { checkFlagsForTemplate, optionsSchema, resolveCreatableTemplate } from './create.ts';
import { parseOptions } from '../lib/options.ts';
import { findTemplate, listAllTemplates, type TemplateListing } from '../lib/templates.ts';

const listing: TemplateListing = {
	templates: [
		{
			name: 'minimal',
			description: '',
			backend: true,
			source: 'builtin',
			category: 'starter',
			dir: '/x'
		},
		{
			name: 'stdout',
			description: '',
			backend: true,
			source: 'remote',
			category: 'blog',
			dir: '/y'
		}
	]
};

describe('create options', () => {
	test('accepts built-in and registry templates alike', () => {
		expect(
			parseOptions(optionsSchema(listing), { install: true, template: 'stdout' }).template
		).toBe('stdout');
	});

	test('lists the choices by category for an unknown template', () => {
		expect(() => parseOptions(optionsSchema(listing), { install: true, template: 'vue' })).toThrow(
			'--template: must be one of: starter: minimal; blog: stdout'
		);
	});

	test('explains when the registry could not be reached', () => {
		const offline: TemplateListing = { ...listing, registryError: 'offline' };
		expect(() => parseOptions(optionsSchema(offline), { install: true, template: 'vue' })).toThrow(
			'could not reach the template registry: offline'
		);
	});
});

describe('create link and cms options', () => {
	const parse = (raw: Record<string, unknown>) =>
		parseOptions(optionsSchema(listing), { install: true, ...raw });

	test('accepts new, none or a project id for --link', () => {
		expect(parse({ link: 'new' }).link).toBe('new');
		expect(parse({ link: 'none' }).link).toBe('none');
		expect(parse({ link: '2tj321uzke7k7fn' }).link).toBe('2tj321uzke7k7fn');
		expect(() => parse({ link: 'yes' })).toThrow(
			'--link: must be `new`, `none` or a velastack.dev project id'
		);
	});

	test('accepts only an absolute http(s) URL for --cms', () => {
		expect(parse({ cms: ' https://velastack.dev/v1/projects/2tj321uzke7k7fn/cms ' }).cms).toBe(
			'https://velastack.dev/v1/projects/2tj321uzke7k7fn/cms'
		);
		expect(() => parse({ cms: 'velastack.dev/cms' })).toThrow('--cms: must be an absolute CMS URL');
	});
});

describe('checkFlagsForTemplate', () => {
	const cmsTemplate = { ...listing.templates[1]!, backend: false, cms: true };
	const plain = listing.templates[0]!;
	const base = { install: true as const };

	test('--cms only applies to a template that reads from a CMS', () => {
		expect(() =>
			checkFlagsForTemplate(cmsTemplate, { ...base, cms: 'https://x/cms' })
		).not.toThrow();
		expect(() => checkFlagsForTemplate(plain, { ...base, cms: 'https://x/cms' })).toThrow(
			"--cms doesn't apply to the minimal template"
		);
	});

	test('--team needs --link new', () => {
		expect(() => checkFlagsForTemplate(plain, { ...base, team: 't', link: 'new' })).not.toThrow();
		expect(() => checkFlagsForTemplate(plain, { ...base, team: 't' })).toThrow(
			'--team only applies together with --link new'
		);
		expect(() => checkFlagsForTemplate(plain, { ...base, team: 't', link: 'none' })).toThrow();
	});

	test('admin credentials need a backend', () => {
		expect(() => checkFlagsForTemplate(cmsTemplate, { ...base, email: 'a@b.co' })).toThrow(
			"--email and --password don't apply"
		);
	});
});

describe('resolveCreatableTemplate', () => {
	let tmp: string;
	let origHome: string | undefined;
	let origUserProfile: string | undefined;
	let indexUrl: string;
	// Unique per run, so leftover download directories can be told apart.
	const tag = `t${process.pid}${Date.now().toString(36)}`;

	/** A file: registry with one template per entry, packed the way the registry publishes. */
	async function buildRegistry(templates: Record<string, { cms?: string; page: string }>) {
		const registry = path.join(tmp, 'registry');
		fs.mkdirSync(registry, { recursive: true });
		const entries = [];
		for (const [name, spec] of Object.entries(templates)) {
			const source = path.join(tmp, 'source', name);
			fs.mkdirSync(path.join(source, 'src', 'routes'), { recursive: true });
			fs.writeFileSync(
				path.join(source, 'template.json'),
				JSON.stringify({ description: name, backend: false })
			);
			const dependencies = spec.cms ? { '@velastack/cms': spec.cms } : {};
			fs.writeFileSync(
				path.join(source, 'package.template.json'),
				JSON.stringify({
					name: '~TODO~',
					dependencies,
					devDependencies: { '@sveltejs/kit': '^2.70.3' }
				})
			);
			fs.writeFileSync(path.join(source, 'src', 'routes', '+page.svelte'), spec.page);
			const file = path.join(registry, `${name}.tgz`);
			await tar.create({ gzip: true, file, cwd: path.join(tmp, 'source'), portable: true }, [name]);
			const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
			entries.push({
				name,
				description: name,
				backend: false,
				cms: true,
				file: `${name}.tgz`,
				sha256
			});
		}
		fs.writeFileSync(
			path.join(registry, 'index.json'),
			JSON.stringify({ schemaVersion: 1, templates: entries })
		);
		indexUrl = pathToFileURL(path.join(registry, 'index.json')).href;
	}

	const leftovers = (name: string) =>
		fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(`vela-template-${name}-`));

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-create-'));
		origHome = process.env.HOME;
		origUserProfile = process.env.USERPROFILE;
		process.env.HOME = tmp;
		process.env.USERPROFILE = tmp;
	});

	afterEach(() => {
		if (origHome === undefined) delete process.env.HOME;
		else process.env.HOME = origHome;
		if (origUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = origUserProfile;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('refuses a registry template still on CmsRepeater and leaves no download behind', async () => {
		const name = `old-${tag}`;
		await buildRegistry({
			[name]: {
				cms: '^0.4.0',
				page: "<script>\n\timport { CmsRepeater } from '@velastack/cms';\n</script>\n"
			}
		});
		const listing = await listAllTemplates({ indexUrl });
		await expect(resolveCreatableTemplate(findTemplate(listing, name))).rejects.toThrow(
			`Template ${name} hasn't been updated for SvelteKit 3 yet: it uses CmsRepeater`
		);
		expect(leftovers(name)).toEqual([]);
	});

	test('downloads a registry template already on a newer @velastack/cms', async () => {
		const name = `new-${tag}`;
		await buildRegistry({
			[name]: {
				cms: '^0.5.1',
				page: "<script>\n\timport { CmsText } from '@velastack/cms';\n</script>\n"
			}
		});
		const listing = await listAllTemplates({ indexUrl });
		const resolved = await resolveCreatableTemplate(findTemplate(listing, name));
		try {
			expect(fs.existsSync(path.join(resolved.dir, 'package.template.json'))).toBe(true);
		} finally {
			resolved.cleanup();
		}
		expect(leftovers(name)).toEqual([]);
	});
});
