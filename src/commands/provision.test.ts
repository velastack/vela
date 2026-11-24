import { describe, expect, test } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { provision, provisionArgs } from './provision.ts';

describe('provision arguments', () => {
	test('swap is left to the script by default', () => {
		expect(provisionArgs({}, '0.42.2')).toEqual([
			'--pb-version',
			'0.42.2',
			'--node-major',
			'26',
			'--cli-version',
			pkg.version
		]);
		expect(provisionArgs({ swap: true }, '0.42.2')).not.toContain('--no-swap');
	});

	test('--no-swap reaches the script', () => {
		expect(provisionArgs({ swap: false, nodeMajor: '24' }, '0.42.2')).toEqual([
			'--pb-version',
			'0.42.2',
			'--node-major',
			'24',
			'--cli-version',
			pkg.version,
			'--no-swap'
		]);
	});

	test('the command offers --no-swap', () => {
		expect(provision.options.map((option) => option.long)).toContain('--no-swap');
	});
});
