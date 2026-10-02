import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { restoreTemplateNames } from './template-files.ts';

/**
 * Test-only: the `vela create` output of vela 0.14.5 (SvelteKit 2), trimmed of
 * node_modules, databases, `.env` and large assets, kept under
 * `test-fixtures/kit2`. `.gitignore`/`.npmrc` are stored under their
 * publish-safe names, as templates are, so the fixture's own ignore rules do
 * not hide its files from this repository.
 */
export const KIT2_FIXTURES = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../test-fixtures/kit2'
);

/** A fresh copy of a Kit 2 fixture in a temp dir, optionally committed to a new git repo. */
export function copyKit2Fixture(name: 'minimal' | 'static', { git = false } = {}): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vela-kit2-${name}-`));
	fs.cpSync(path.join(KIT2_FIXTURES, name), dir, { recursive: true });
	restoreTemplateNames(dir);
	if (git) commitAll(dir, 'init', true);
	return dir;
}

/** Commit everything in `dir`, initialising the repository first when asked. */
export function commitAll(dir: string, message: string, init = false): void {
	const git = (...args: string[]) =>
		execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], {
			cwd: dir,
			stdio: 'ignore'
		});
	if (init) git('init', '-q');
	git('add', '-A');
	git('commit', '-q', '--allow-empty', '-m', message);
}

/** Every file under `dir` (minus `.git`), with its contents, for before/after comparisons. */
export function snapshot(dir: string): Map<string, string> {
	const files = new Map<string, string>();
	for (const rel of fs.globSync('**/*', { cwd: dir, exclude: (name) => name === '.git' })) {
		const full = path.join(dir, rel);
		if (fs.statSync(full).isFile()) files.set(rel, fs.readFileSync(full, 'utf8'));
	}
	return files;
}
