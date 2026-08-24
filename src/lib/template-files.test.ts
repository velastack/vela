import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { applyTemplateFiles, restoreTemplateNames, templateName } from './template-files.ts';
import { listProjectTemplates } from './templates.ts';

const PROJECT_TEMPLATES = listProjectTemplates();

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-template-files-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('templateName', () => {
	test('maps names npm strips to their publish-safe form', () => {
		expect(templateName('.gitignore')).toBe('_gitignore');
		expect(templateName('.npmrc')).toBe('_npmrc');
	});

	test('leaves other files untouched', () => {
		expect(templateName('.ignore')).toBe('.ignore');
		expect(templateName('components.json')).toBe('components.json');
		expect(templateName('src/app.css')).toBe('src/app.css');
	});

	test('preserves the directory of a nested file', () => {
		expect(templateName('nested/.gitignore')).toBe(path.join('nested', '_gitignore'));
	});
});

describe('restoreTemplateNames', () => {
	test('restores publish-safe names after a copy', () => {
		fs.writeFileSync(path.join(tmp, '_gitignore'), 'node_modules\n');
		fs.writeFileSync(path.join(tmp, '_npmrc'), 'engine-strict=true\n');

		restoreTemplateNames(tmp);

		expect(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8')).toBe('node_modules\n');
		expect(fs.readFileSync(path.join(tmp, '.npmrc'), 'utf8')).toBe('engine-strict=true\n');
		expect(fs.existsSync(path.join(tmp, '_gitignore'))).toBe(false);
		expect(fs.existsSync(path.join(tmp, '_npmrc'))).toBe(false);
	});

	test('is a no-op when nothing needs renaming', () => {
		fs.writeFileSync(path.join(tmp, 'keep.txt'), 'x');
		expect(() => restoreTemplateNames(tmp)).not.toThrow();
		expect(fs.readdirSync(tmp)).toEqual(['keep.txt']);
	});
});

describe('shipped templates', () => {
	// npm silently drops files named `.gitignore` or `.npmrc` from the published
	// tarball, so a template holding one would scaffold projects missing it.
	test.each(PROJECT_TEMPLATES)('$name stores no npm-stripped filenames', ({ dir }) => {
		expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
		expect(fs.existsSync(path.join(dir, '.npmrc'))).toBe(false);
	});

	test.each(PROJECT_TEMPLATES)('$name ships publish-safe equivalents', ({ dir }) => {
		expect(fs.existsSync(path.join(dir, '_gitignore'))).toBe(true);
		expect(fs.existsSync(path.join(dir, '_npmrc'))).toBe(true);
	});
});

describe('applyTemplateFiles', () => {
	const values = { appName: 'My App', cliVersion: '9.9.9' };

	test('writes each source to its real name and removes the source', () => {
		fs.writeFileSync(path.join(tmp, 'package.template.json'), '{"name":"~TODO~"}');

		expect(applyTemplateFiles(tmp, values)).toEqual(['package.json']);

		expect(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')).toBe('{"name":"my-app"}');
		expect(fs.existsSync(path.join(tmp, 'package.template.json'))).toBe(false);
	});

	test('reaches nested files', () => {
		fs.mkdirSync(path.join(tmp, 'src', 'lib'), { recursive: true });
		fs.writeFileSync(path.join(tmp, 'src', 'lib', 'site.template.ts'), "name: '~APP_NAME~'");

		expect(applyTemplateFiles(tmp, values)).toEqual([path.join('src', 'lib', 'site.ts')]);
		expect(fs.readFileSync(path.join(tmp, 'src', 'lib', 'site.ts'), 'utf8')).toBe("name: 'My App'");
	});

	test('leaves files without the .template. infix alone', () => {
		fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{"~TODO~":true}');

		expect(applyTemplateFiles(tmp, values)).toEqual([]);
		expect(fs.readFileSync(path.join(tmp, 'tsconfig.json'), 'utf8')).toBe('{"~TODO~":true}');
	});

	test('is a no-op on a template that ships none', () => {
		expect(() => applyTemplateFiles(tmp, values)).not.toThrow();
	});
});
