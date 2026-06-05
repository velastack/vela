import { describe, it, expect, vi } from 'vitest';
import { collectionSpecToArgv } from './ai-to-argv.ts';
import type { CollectionSpec } from './ai-client.ts';

vi.mock('@clack/prompts', () => ({
	log: { warn: vi.fn() }
}));

describe('collectionSpecToArgv', () => {
	it('emits model name + name:type pairs', () => {
		const spec: CollectionSpec = {
			name: 'addresses',
			type: 'base',
			fields: [
				{ name: 'street', type: 'text', required: true },
				{ name: 'city', type: 'text' }
			]
		};
		expect(collectionSpecToArgv(spec)).toEqual(['addresses', 'street:text!', 'city:text']);
	});

	it('emits select fields with values', () => {
		const spec: CollectionSpec = {
			name: 'employees',
			type: 'base',
			fields: [
				{ name: 'role', type: 'select', values: ['server', 'chef', 'host'], required: true }
			]
		};
		expect(collectionSpecToArgv(spec)).toEqual([
			'employees',
			'role:select(server,chef,host)!'
		]);
	});

	it('singularizes relation collectionName for relation fields', () => {
		const spec: CollectionSpec = {
			name: 'orders',
			type: 'base',
			fields: [{ name: 'customer', type: 'relation', collectionName: 'customers', required: true }]
		};
		expect(collectionSpecToArgv(spec)).toEqual(['orders', 'customer:customer!']);
	});

	it('handles -ies plurals when singularizing', () => {
		const spec: CollectionSpec = {
			name: 'products',
			type: 'base',
			fields: [{ name: 'category', type: 'relation', collectionName: 'categories' }]
		};
		expect(collectionSpecToArgv(spec)).toEqual(['products', 'category:category']);
	});

	it('drops + warns on relation without collectionName', () => {
		const spec: CollectionSpec = {
			name: 'orders',
			type: 'base',
			fields: [
				{ name: 'name', type: 'text', required: true },
				{ name: 'broken', type: 'relation' }
			]
		};
		expect(collectionSpecToArgv(spec)).toEqual(['orders', 'name:text!']);
	});

	it('drops unknown field types', () => {
		const spec: CollectionSpec = {
			name: 'x',
			type: 'base',
			fields: [
				{ name: 'good', type: 'text' },
				{ name: 'mystery', type: 'geojson' }
			]
		};
		expect(collectionSpecToArgv(spec)).toEqual(['x', 'good:text']);
	});
});
