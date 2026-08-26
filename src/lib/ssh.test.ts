import { describe, expect, test } from 'vitest';
import { shellQuote } from './ssh.ts';

describe('shellQuote', () => {
	test('leaves safe words alone', () => {
		expect(shellQuote('prod')).toBe('prod');
		expect(shellQuote('/var/lib/vela')).toBe('/var/lib/vela');
		expect(shellQuote('a.b-c_d@e')).toBe('a.b-c_d@e');
	});

	test('quotes what a remote shell would otherwise mangle', () => {
		// An empty argument is the one that bites: ssh joins argv with spaces, so
		// an unquoted '' simply disappears from the remote command.
		expect(shellQuote('')).toBe("''");
		expect(shellQuote('two words')).toBe("'two words'");
		expect(shellQuote('a;rm -rf /')).toBe("'a;rm -rf /'");
	});

	test('escapes embedded single quotes', () => {
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});
});
