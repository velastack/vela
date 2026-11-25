import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	blockingEntries,
	mergeGitignore,
	summarizeEntries,
	templateProjectFiles
} from './create-target.ts';
import { copyTemplate, findProjectTemplate } from './templates.ts';

describe('blockingEntries', () => {
	let tmp: string;
	const minimal = findProjectTemplate('minimal').dir;
	const touch = (rel: string, content = '') => {
		fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
		fs.writeFileSync(path.join(tmp, rel), content);
	};

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-create-target-'));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('a directory that does not exist yet is fine', () => {
		expect(blockingEntries(path.join(tmp, 'new'), minimal)).toEqual([]);
	});

	test('tolerates .git and .env, the case from the friction log', () => {
		touch('.git/HEAD');
		touch('.env', 'SPOTIFY_CLIENT_ID=abc\n');
		expect(blockingEntries(tmp, minimal)).toEqual([]);
	});

	test('tolerates the rest of the list when the template writes none of it', () => {
		for (const file of [
			'.env.local',
			'.DS_Store',
			'.gitattributes',
			'.gitignore',
			'LICENSE',
			'LICENSE.md',
			'README.md',
			'.idea/workspace.xml',
			'.claude/settings.json',
			'.vscode/launch.json',
			'.github/workflows/ci.yml'
		]) {
			touch(file);
		}
		expect(blockingEntries(tmp, minimal)).toEqual([]);
	});

	test('anything else blocks, including names that merely start with .git', () => {
		touch('.gitlab-ci.yml');
		touch('.github-notes');
		touch('src/index.ts');
		touch('package.json');
		expect(blockingEntries(tmp, minimal)).toEqual([
			'.github-notes',
			'.gitlab-ci.yml',
			'package.json',
			'src'
		]);
	});

	test('a tolerated file the template also writes blocks, by the path that collides', () => {
		touch('.env.example');
		touch('.vscode/settings.json');
		touch('.vscode/launch.json');
		expect(blockingEntries(tmp, minimal)).toEqual(['.env.example', '.vscode/settings.json']);
	});

	test('a README blocks once the template ships one', () => {
		const template = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-template-'));
		try {
			fs.writeFileSync(path.join(template, 'README.md'), '# Template\n');
			fs.writeFileSync(path.join(template, 'template.json'), '{}');
			touch('README.md');
			touch('LICENSE');
			expect(blockingEntries(tmp, template)).toEqual(['README.md']);
		} finally {
			fs.rmSync(template, { recursive: true, force: true });
		}
	});

	test('no built-in template writes a root README, LICENSE or .github', () => {
		for (const name of ['minimal', 'static']) {
			const files = [...templateProjectFiles(findProjectTemplate(name).dir)];
			expect(files.filter((f) => /^(readme|license|\.github)/i.test(f))).toEqual([]);
			expect(files).toContain('.gitignore');
			expect(files).toContain('package.json');
			expect(files).not.toContain('template.json');
		}
	});

	test('copyTemplate keeps an existing .gitignore and adds what it lacks', () => {
		touch('.gitignore', 'node_modules\nsecrets.txt\n');
		copyTemplate(findProjectTemplate('minimal'), tmp);
		const merged = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8');
		expect(merged.startsWith('node_modules\nsecrets.txt\n')).toBe(true);
		expect(merged).toContain('/.svelte-kit');
		expect(merged).toContain('test-data/');
		expect(merged.match(/^node_modules$/gm)).toHaveLength(1);
		expect(fs.existsSync(path.join(tmp, '_gitignore'))).toBe(false);
	});
});

describe('mergeGitignore', () => {
	test('appends missing rules under their comment and leaves the rest alone', () => {
		const existing = '# mine\n.env\nnode_modules';
		const template = 'node_modules\n\n# Env\n.env\n.env.*\n\n# OS\n.DS_Store\n';
		expect(mergeGitignore(existing, template)).toBe(
			'# mine\n.env\nnode_modules\n\n# Env\n.env.*\n\n# OS\n.DS_Store\n'
		);
	});

	test('nothing missing changes nothing', () => {
		expect(mergeGitignore('a\nb\n', '# x\nb\n\na\n')).toBe('a\nb\n');
	});

	test('an empty file takes the template rules', () => {
		expect(mergeGitignore('', '# Output\n/build\n')).toBe('# Output\n/build\n');
	});
});

describe('summarizeEntries', () => {
	test('names the first few and counts the rest', () => {
		expect(summarizeEntries(['a', 'b'])).toBe('a, b');
		expect(summarizeEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e and 2 more');
	});
});
