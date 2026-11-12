import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const CANCEL = Symbol('cancel');
const multiselect = vi.fn();

vi.mock('@clack/prompts', () => ({
	log: { error: () => {}, info: () => {}, success: () => {}, warn: () => {}, message: () => {} },
	multiselect: (...args: unknown[]) => multiselect(...args),
	isCancel: (value: unknown) => value === CANCEL,
	cancel: () => {}
}));

// The pattern itself is covered in @velastack/patterns. Here it writes the
// config the way it does there, then hands over to the `after` step.
let nextSteps: string[] = [];
vi.mock('../../lib/pattern-runner.ts', () => ({
	runPattern: async (
		_slug: string,
		_argv: string[],
		_input: unknown,
		report: { nextSteps: string[] },
		after: () => Promise<void>
	) => {
		fs.writeFileSync(
			path.join(process.cwd(), 'wuchale.config.js'),
			'export default defineConfig({ adapters: { main: svelte({ url: { localize: "src/lib/url.ts", patterns: ["/"] } }) } });\n'
		);
		await after();
		nextSteps = report.nextSteps;
	}
}));

import { i18n } from './i18n.ts';

describe('enable i18n', () => {
	let tmpDir: string;
	let cwd: string;

	const config = () => fs.readFileSync(path.join(tmpDir, 'wuchale.config.js'), 'utf8');
	const interactive = () => {
		vi.stubEnv('CI', '');
		Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
	};

	beforeEach(() => {
		tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vela-enable-i18n-test-')));
		fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}\n');
		for (const dir of ['(public)', '(public)/about']) {
			fs.mkdirSync(path.join(tmpDir, 'src/routes', dir), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, 'src/routes', dir, '+page.svelte'), '');
		}
		cwd = process.cwd();
		process.chdir(tmpDir);
		multiselect.mockReset();
		nextSteps = [];
	});

	afterEach(() => {
		process.chdir(cwd);
		process.exitCode = undefined;
		vi.unstubAllEnvs();
		Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('at a terminal it asks which pages to localize and writes the answer', async () => {
		interactive();
		multiselect.mockResolvedValue(['/', '/about']);
		await i18n.parseAsync([], { from: 'user' });
		expect(config()).toContain('"/about"');
		expect(nextSteps.join('\n')).toContain('`vela i18n routes` again when you add a page');
		expect(nextSteps.join('\n')).not.toContain('404');
	});

	test('without a terminal it does not ask, and the first next step is the command that does', async () => {
		await i18n.parseAsync([], { from: 'user' });
		expect(multiselect).not.toHaveBeenCalled();
		expect(config()).not.toContain('/about');
		expect(nextSteps[0]).toContain('vela i18n routes');
	});

	test('a cancelled prompt leaves i18n enabled and points at the command', async () => {
		interactive();
		multiselect.mockResolvedValue(CANCEL);
		await i18n.parseAsync([], { from: 'user' });
		expect(config()).not.toContain('/about');
		expect(nextSteps[0]).toContain('vela i18n routes');
		expect(process.exitCode).toBeUndefined();
	});

	test('a failing prompt does not fail the command', async () => {
		interactive();
		multiselect.mockRejectedValue(new Error('tty closed'));
		await i18n.parseAsync([], { from: 'user' });
		expect(nextSteps[0]).toContain('vela i18n routes');
		expect(process.exitCode).toBeUndefined();
	});
});
