import { describe, expect, test } from 'vitest';
import { normalizeArgv } from './argv.ts';

describe('normalizeArgv', () => {
	test('drops the separator so `vela dev -- --open` matches `vela dev --open`', () => {
		expect(normalizeArgv(['dev', '--', '--open'])).toEqual(['dev', '--open']);
	});

	test('leaves arguments without a separator alone', () => {
		expect(normalizeArgv(['dev', '--open', '--port', '3000'])).toEqual([
			'dev',
			'--open',
			'--port',
			'3000'
		]);
	});

	test('leaves field definitions alone', () => {
		const argv = ['generate', 'scaffold', 'post', 'title:text', 'body:editor'];
		expect(normalizeArgv(argv)).toEqual(argv);
	});

	test('drops only the first separator', () => {
		expect(normalizeArgv(['dev', '--', '--open', '--', 'x'])).toEqual(['dev', '--open', '--', 'x']);
	});

	test('handles a bare separator and no arguments at all', () => {
		expect(normalizeArgv(['--'])).toEqual([]);
		expect(normalizeArgv([])).toEqual([]);
	});
});
