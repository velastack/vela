import { describe, expect, test } from 'vitest';
import { isValidKey, parseEnv, serializeEnv } from './remote-env.ts';

describe('serializeEnv', () => {
	test('sorts keys and quotes every value', () => {
		expect(serializeEnv({ B: '2', A: '1' })).toContain('A="1"\nB="2"');
	});

	test('escapes what systemd would otherwise interpret', () => {
		const out = serializeEnv({ K: 'a"b\\c\nd' });
		expect(out).toContain('K="a\\"b\\\\c\\nd"');
	});
});

describe('parseEnv', () => {
	test('round-trips values through serialization', () => {
		const original = {
			SIMPLE: 'value',
			SPACED: 'two words',
			EQUALS: 'a=b=c',
			EMPTY: '',
			QUOTED: 'say "hi"',
			BACKSLASH: 'C:\\path\\to',
			MULTILINE: 'line1\nline2'
		};
		expect(parseEnv(serializeEnv(original))).toEqual(original);
	});

	test('ignores comments, blanks and malformed names', () => {
		const parsed = parseEnv('# comment\n\nGOOD="1"\n2BAD="x"\nno-equals\n');
		expect(parsed).toEqual({ GOOD: '1' });
	});

	test('reads unquoted values too', () => {
		expect(parseEnv('KEY=value')).toEqual({ KEY: 'value' });
	});
});

describe('isValidKey', () => {
	test('accepts shell-safe names only', () => {
		expect(isValidKey('STRIPE_SECRET_KEY')).toBe(true);
		expect(isValidKey('_private')).toBe(true);
		expect(isValidKey('2FA')).toBe(false);
		expect(isValidKey('WITH-DASH')).toBe(false);
		expect(isValidKey('')).toBe(false);
	});
});
