import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const errors: string[] = [];

vi.mock('@clack/prompts', () => ({
	log: {
		error: (text: string) => errors.push(text),
		message: () => {}
	},
	cancel: () => {}
}));

const x = vi.fn();
vi.mock('tinyexec', () => ({ x: (...args: unknown[]) => x(...args) }));

import { i18n } from './i18n.ts';

describe('i18n', () => {
	let tmpDir: string;
	let cwd: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vela-i18n-test-')));
		fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}\n');
		cwd = process.cwd();
		errors.length = 0;
		x.mockReset();
	});

	afterEach(() => {
		process.chdir(cwd);
		process.exitCode = undefined;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('points at `vela enable i18n` when there is no wuchale config', async () => {
		process.chdir(tmpDir);
		await i18n.parseAsync(['extract'], { from: 'user' });
		expect(errors.join('\n')).toContain('vela enable i18n');
		expect(process.exitCode).toBe(1);
		expect(x).not.toHaveBeenCalled();
	});

	test('runs wuchale from the project root when called from a subdirectory', async () => {
		fs.writeFileSync(path.join(tmpDir, 'wuchale.config.js'), 'export default {};\n');
		const sub = path.join(tmpDir, 'src');
		fs.mkdirSync(sub);
		process.chdir(sub);
		await i18n.parseAsync(['status'], { from: 'user' });
		expect(errors).toEqual([]);
		expect(x).toHaveBeenCalledOnce();
		expect(x.mock.calls[0][2]).toMatchObject({ nodeOptions: { cwd: tmpDir } });
	});
});
