import { describe, expect, test } from 'vitest';
import { checkFlagsForTemplate, optionsSchema } from './create.ts';
import { parseOptions } from '../lib/options.ts';
import type { TemplateListing } from '../lib/templates.ts';

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
