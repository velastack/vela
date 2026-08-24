import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	DEFAULT_TEMPLATE,
	TEMPLATE_MANIFEST,
	findProjectTemplate,
	listProjectTemplates,
	projectTemplateNames,
	templatesDir
} from './templates.ts';

describe('templatesDir', () => {
	test('resolves the packaged templates directory', () => {
		expect(fs.existsSync(templatesDir())).toBe(true);
	});

	test('holds the ui theme files `vela ui base` reads', () => {
		expect(fs.existsSync(path.join(templatesDir(), 'ui', 'css', 'slate.css'))).toBe(true);
	});
});

describe('listProjectTemplates', () => {
	test('finds the templates that ship with the CLI', () => {
		expect(listProjectTemplates().map((t) => t.name)).toEqual(['minimal', 'static']);
	});

	// `templates/ui` holds shadcn theme files, not a scaffoldable project.
	test('ignores template directories without a manifest', () => {
		expect(fs.existsSync(path.join(templatesDir(), 'ui'))).toBe(true);
		expect(listProjectTemplates().map((t) => t.name)).not.toContain('ui');
	});

	test('every template describes itself', () => {
		for (const template of listProjectTemplates()) {
			expect(template.description.length).toBeGreaterThan(0);
		}
	});

	// `vela create` scaffolds package.json from this file, so a template without
	// one would fail after it had already copied itself into the target.
	test('every template ships a package.template.json', () => {
		for (const template of listProjectTemplates()) {
			expect(fs.existsSync(path.join(template.dir, 'package.template.json'))).toBe(true);
		}
	});

	test('the default template exists', () => {
		expect(projectTemplateNames()).toContain(DEFAULT_TEMPLATE);
	});
});

describe('backend', () => {
	test('minimal scaffolds PocketBase, static does not', () => {
		expect(findProjectTemplate('minimal').backend).toBe(true);
		expect(findProjectTemplate('static').backend).toBe(false);
	});

	// A backend template is one whose hooks wire up PocketBase — not merely one
	// that has hooks, since a frontend-only template may have its own. The flag
	// and the files have to agree or `vela create` skips the wrong step.
	test('the manifest flag matches whether the template wires up PocketBase', () => {
		for (const template of listProjectTemplates()) {
			const hooks = path.join(template.dir, 'src', 'hooks.server.ts');
			const wiresUpPocketbase =
				fs.existsSync(hooks) && fs.readFileSync(hooks, 'utf8').includes('@velastack/pocketbase');
			expect(wiresUpPocketbase).toBe(template.backend);
		}
	});

	test('filters by backend', () => {
		expect(projectTemplateNames({ backend: true })).toEqual(['minimal']);
		expect(projectTemplateNames({ backend: false })).toEqual(['static']);
	});
});

describe('findProjectTemplate', () => {
	test('returns the directory the template lives in', () => {
		const template = findProjectTemplate('minimal');
		expect(template.dir).toBe(path.join(templatesDir(), 'minimal'));
		expect(fs.existsSync(path.join(template.dir, TEMPLATE_MANIFEST))).toBe(true);
	});

	test('throws for an unknown template', () => {
		expect(() => findProjectTemplate('vue')).toThrow('Template not found: vue');
	});
});
