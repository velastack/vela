import { describe, expect, test } from 'vitest';
import { createPocketbaseLogFilter, isAuthLookupLine } from './pocketbase-log-filter.ts';

const LOOKUP =
	"[0.00ms] SELECT `_superusers`.* FROM `_superusers` WHERE `_superusers`.`id`='ca7o0tsnmserg0f' LIMIT 1";

async function run(chunks: string[]): Promise<string> {
	const filter = createPocketbaseLogFilter();
	let out = '';
	filter.on('data', (d) => (out += d.toString()));
	const done = new Promise((resolve) => filter.on('end', resolve));
	for (const chunk of chunks) filter.write(chunk);
	filter.end();
	await done;
	return out;
}

describe('isAuthLookupLine', () => {
	test('matches the superuser token lookup', () => {
		expect(isAuthLookupLine(LOOKUP)).toBe(true);
	});

	test('matches through color codes and a carriage return', () => {
		expect(isAuthLookupLine(`\x1b[90m${LOOKUP}\x1b[0m\r`)).toBe(true);
	});

	test('leaves other queries on the same table alone', () => {
		expect(
			isAuthLookupLine(
				"[0.00ms] SELECT `_superusers`.* FROM `_superusers` WHERE `email`='a@b.c' LIMIT 1"
			)
		).toBe(false);
		expect(isAuthLookupLine("[1.00ms] UPDATE `_superusers` SET `tokenKey`='x'")).toBe(false);
	});

	test('leaves lookups on other collections alone', () => {
		expect(
			isAuthLookupLine("[0.00ms] SELECT `users`.* FROM `users` WHERE `users`.`id`='abc' LIMIT 1")
		).toBe(false);
	});
});

describe('createPocketbaseLogFilter', () => {
	test('drops lookup lines and keeps the rest in order', async () => {
		expect(await run([`first\n${LOOKUP}\nsecond\n`])).toBe('first\nsecond\n');
	});

	test('handles a lookup line split across chunks', async () => {
		const half = Math.floor(LOOKUP.length / 2);
		expect(await run(['first\n' + LOOKUP.slice(0, half), LOOKUP.slice(half) + '\nsecond\n'])).toBe(
			'first\nsecond\n'
		);
	});

	test('flushes a trailing line without a newline', async () => {
		expect(await run(['first\nlast'])).toBe('first\nlast');
	});
});
