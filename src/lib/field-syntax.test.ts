import { describe, expect, test } from 'vitest';
import { FIELD_SYNTAX_DOCS, FIELD_SYNTAX_FALLBACK, fieldSyntaxHelp } from './field-syntax.ts';
import { generate } from '../commands/generate.ts';

describe('fieldSyntaxHelp', () => {
	test('uses the patterns export when there is one', () => {
		expect(fieldSyntaxHelp({ FIELD_SYNTAX_HELP: 'Fields:\n  from patterns\n' })).toBe(
			'Fields:\n  from patterns'
		);
	});

	test('falls back to a summary and the docs when the export is missing', () => {
		expect(fieldSyntaxHelp({})).toBe(FIELD_SYNTAX_FALLBACK);
		expect(fieldSyntaxHelp({ FIELD_SYNTAX_HELP: 42 })).toBe(FIELD_SYNTAX_FALLBACK);
		expect(FIELD_SYNTAX_FALLBACK).toContain(FIELD_SYNTAX_DOCS);
	});

	test('the fallback fits 80 columns', () => {
		for (const line of FIELD_SYNTAX_FALLBACK.split('\n')) {
			expect(line.length).toBeLessThanOrEqual(80);
		}
	});

	test('works against the installed patterns, with or without the export', () => {
		expect(fieldSyntaxHelp()).toMatch(/select\(/);
	});
});

describe('generator help', () => {
	function helpOf(name: string): string {
		const command = generate.commands.find((c) => c.name() === name)!;
		let out = '';
		command.configureOutput({ writeOut: (text) => (out += text) });
		command.outputHelp();
		return out;
	}

	test.each(['resource', 'scaffold', 'schema', 'form', 'migration'])(
		'generate %s --help ends with the field syntax',
		(name) => {
			expect(helpOf(name)).toContain(fieldSyntaxHelp());
		}
	);

	test('generators without field definitions do not print it', () => {
		expect(helpOf('workflow')).not.toContain(fieldSyntaxHelp());
	});
});
