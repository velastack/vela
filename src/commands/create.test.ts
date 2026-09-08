import { describe, expect, test } from 'vitest';
import { optionsSchema } from './create.ts';
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
