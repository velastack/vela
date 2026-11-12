import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const errors: string[] = [];
const notes: string[] = [];
const multiselect = vi.fn();

vi.mock('@clack/prompts', () => ({
	log: {
		error: (text: string) => errors.push(text),
		info: (text: string) => notes.push(text),
		success: (text: string) => notes.push(text),
		warn: (text: string) => notes.push(text),
		message: () => {}
	},
	multiselect: (...args: unknown[]) => multiselect(...args),
	isCancel: (value: unknown) => value === CANCEL,
	cancel: () => {}
}));

const CANCEL = Symbol('cancel');

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
		notes.length = 0;
		x.mockReset();
		multiselect.mockReset();
	});

	afterEach(() => {
		process.chdir(cwd);
		process.exitCode = undefined;
		vi.unstubAllEnvs();
		Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
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

	describe('routes', () => {
		const CONFIG =
			'export default defineConfig({ adapters: { main: svelte({ url: { localize: "src/lib/url.ts", patterns: ["/"] } }) } });\n';

		const page = (dir: string) => {
			fs.mkdirSync(path.join(tmpDir, 'src/routes', dir), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, 'src/routes', dir, '+page.svelte'), '');
		};
		const patterns = () =>
			[
				...fs
					.readFileSync(path.join(tmpDir, 'wuchale.config.js'), 'utf8')
					.match(/patterns: \[([^\]]*)\]/)![1]!
					.matchAll(/"([^"]+)"/g)
			].map((m) => m[1]);
		const interactive = () => {
			vi.stubEnv('CI', '');
			Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
		};

		beforeEach(() => {
			fs.writeFileSync(path.join(tmpDir, 'wuchale.config.js'), CONFIG);
			page('(public)');
			page('(public)/about');
			page('(public)/blog/[slug]');
			page('(app)/dashboard');
			process.chdir(tmpDir);
		});

		test('--all lists every page and re-extracts', async () => {
			await i18n.parseAsync(['routes', '--all'], { from: 'user' });
			expect(errors).toEqual([]);
			expect(patterns()).toEqual(['/', '/about', '/blog/*', '/dashboard']);
			expect(multiselect).not.toHaveBeenCalled();
			expect(x).toHaveBeenCalledOnce();
		});

		test('--all leaves out a pattern broad enough to catch static files', async () => {
			page('(public)/[slug]');
			await i18n.parseAsync(['routes', '--all'], { from: 'user' });
			expect(patterns()).toEqual(['/', '/about', '/blog/*', '/dashboard']);
			expect(notes.join('\n')).toContain('- /* (/[slug])');
		});

		test('without a terminal it asks for --all and writes nothing', async () => {
			await i18n.parseAsync(['routes'], { from: 'user' });
			expect(errors.join('\n')).toContain('--all');
			expect(process.exitCode).toBe(1);
			expect(patterns()).toEqual(['/']);
			expect(x).not.toHaveBeenCalled();
		});

		test('offers the public pages checked and the app pages unchecked', async () => {
			interactive();
			multiselect.mockResolvedValue(['/', '/about']);
			await i18n.parseAsync(['routes'], { from: 'user' });
			const prompt = multiselect.mock.calls[0]![0];
			expect(prompt.options.map((option: { value: string }) => option.value)).toEqual([
				'/',
				'/about',
				'/blog/*',
				'/dashboard'
			]);
			expect(prompt.initialValues).toEqual(['/', '/about', '/blog/*']);
			expect(patterns()).toEqual(['/', '/about']);
			expect(x).toHaveBeenCalledOnce();
		});

		test('a cancelled prompt writes nothing', async () => {
			interactive();
			multiselect.mockResolvedValue(CANCEL);
			await i18n.parseAsync(['routes'], { from: 'user' });
			expect(patterns()).toEqual(['/']);
			expect(x).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		});

		test('unchecking a listed page removes it', async () => {
			interactive();
			multiselect.mockResolvedValue(['/about']);
			await i18n.parseAsync(['routes'], { from: 'user' });
			expect(patterns()).toEqual(['/about']);
		});
	});
});
