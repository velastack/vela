import process from 'node:process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ERROR_TAIL_LINES, isLiveTerminal, outputTail, taskLog } from './task-log.ts';

// Erase-line, cursor movement and the like: what clack's live task log writes.
// eslint-disable-next-line no-control-regex
const CURSOR_SEQUENCE = /\x1b\[\d*[A-HJKST]/;

describe('taskLog off a terminal', () => {
	let written: string;

	beforeEach(() => {
		written = '';
		vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			written += String(chunk);
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	test('prints the title once, nothing per chunk, then the success line', () => {
		const log = taskLog({ title: 'Installing dependencies with pnpm...' }, false);
		const afterTitle = written;
		expect(afterTitle).toContain('Installing dependencies with pnpm...');

		for (let i = 0; i < 500; i++) log.message(`Progress: resolved ${i}\r`, { raw: true });
		log.message('a pattern line');
		expect(written).toBe(afterTitle);

		log.success('Successfully installed dependencies');
		expect(written).toContain('Successfully installed dependencies');
		expect(written).not.toContain('Progress: resolved');
		expect(written.match(/Installing dependencies/g)).toHaveLength(1);
		expect(written).not.toMatch(CURSOR_SEQUENCE);
	});

	test('on error prints the tail of the output, then the error line', () => {
		const log = taskLog({ title: 'Installing...' }, false);
		for (let i = 1; i <= 100; i++) log.message(`line ${i}\n`, { raw: true });
		log.message('\x1b[2K\x1b[1Anpm error code ERESOLVE\n', { raw: true });
		log.error('Failed to install dependencies');

		expect(written).toContain('npm error code ERESOLVE');
		expect(written).toContain(`line ${100 - ERROR_TAIL_LINES + 2}`);
		expect(written).not.toContain(`line ${100 - ERROR_TAIL_LINES + 1}\n`);
		expect(written.indexOf('npm error code ERESOLVE')).toBeLessThan(
			written.indexOf('Failed to install dependencies')
		);
		expect(written).not.toMatch(CURSOR_SEQUENCE);
	});

	test('a silent failure prints only the error line', () => {
		const log = taskLog({ title: 'Applying...' }, false);
		const afterTitle = written;
		log.error('Could not apply');
		expect(written.slice(afterTitle.length)).toMatch(/Could not apply/);
	});

	test('CI counts as off a terminal even when stdout is one', () => {
		vi.stubEnv('CI', '1');
		expect(isLiveTerminal()).toBe(false);
	});

	test('a pipe is not a live terminal', () => {
		vi.stubEnv('CI', '');
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
		Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
		try {
			expect(isLiveTerminal()).toBe(false);
		} finally {
			if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
			else delete (process.stdout as { isTTY?: boolean }).isTTY;
		}
	});
});

describe('outputTail', () => {
	test('keeps the last lines, split on carriage returns too, without escapes', () => {
		expect(outputTail('a\r\nb\rc\n\n\x1b[32md\x1b[0m\n', 2)).toBe('c\nd');
	});
});
