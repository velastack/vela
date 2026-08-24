import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { parseOptions } from './options.ts';

const schema = v.strictObject({
	install: v.union([v.boolean(), v.picklist(['npm', 'pnpm'])], 'must be a package manager'),
	template: v.optional(v.picklist(['minimal', 'static'], 'must be one of: minimal, static')),
	email: v.optional(v.pipe(v.string(), v.email('must be a valid email address'))),
	password: v.optional(v.pipe(v.string(), v.minLength(8, 'must be at least 8 characters long'))),
	skipRoutes: v.optional(v.boolean())
});

describe('parseOptions', () => {
	test('returns the parsed options when everything validates', () => {
		expect(parseOptions(schema, { install: true, template: 'static' })).toEqual({
			install: true,
			template: 'static'
		});
	});

	test('names the flag that failed', () => {
		expect(() => parseOptions(schema, { install: true, template: 'vue' })).toThrow(
			'--template: must be one of: minimal, static'
		);
	});

	test('reports every bad flag at once, one per line', () => {
		try {
			parseOptions(schema, { install: true, template: 'vue', email: 'nope' });
			expect.unreachable('should have thrown');
		} catch (e) {
			expect((e as Error).message).toBe(
				'--template: must be one of: minimal, static\n--email: must be a valid email address'
			);
		}
	});

	// commander gives valibot `skipRoutes`; the user typed `--skip-routes`.
	test('reports the flag as the user spelled it', () => {
		expect(() => parseOptions(schema, { install: true, skipRoutes: 'yes' })).toThrow(
			/^--skip-routes: /
		);
	});

	test('throws a plain Error rather than a ValiError', () => {
		try {
			parseOptions(schema, { install: true, email: 'nope' });
			expect.unreachable('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(Error);
			expect(v.isValiError(e)).toBe(false);
		}
	});

	// A failed union reports one issue per member; the user only cares once.
	test('collapses repeated messages for the same flag', () => {
		const union = v.strictObject({
			install: v.union([v.literal('npm'), v.literal('pnpm')])
		});
		const message = messageOf(() => parseOptions(union, { install: 'yarn' }));
		expect(message.split('\n')).toHaveLength(1);
		expect(message.startsWith('--install: ')).toBe(true);
	});
});

function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		return (e as Error).message;
	}
	throw new Error('expected a failure');
}
