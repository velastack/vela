import { describe, expect, test } from 'vitest';
import { bakedOrigin } from './preview.ts';

/** The module adapter-node 6 writes beside build/index.js, trimmed to the line that matters. */
function adapterModule(origin: string): string {
	return [
		`export { server } from './server/server.js';`,
		`export const base = "";`,
		`export const origin = ${origin};`,
		`export const env_prefix = "";`
	].join('\n');
}

describe('bakedOrigin', () => {
	test('reads the origin a build baked in', () => {
		expect(bakedOrigin(adapterModule(JSON.stringify('https://velastack.dev')))).toBe(
			'https://velastack.dev'
		);
		expect(bakedOrigin(adapterModule(JSON.stringify('http://localhost:4173')))).toBe(
			'http://localhost:4173'
		);
	});

	test('is null for a build with none', () => {
		expect(bakedOrigin(adapterModule('""'))).toBeNull();
		expect(bakedOrigin(adapterModule('undefined'))).toBeNull();
	});

	test('is null for output that is not adapter-node 6', () => {
		expect(bakedOrigin(`export const base = "";`)).toBeNull();
		expect(bakedOrigin('')).toBeNull();
	});
});
