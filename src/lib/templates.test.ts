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
});

describe('listProjectTemplates', () => {
	test('finds the templates that ship with the CLI', () => {
		expect(listProjectTemplates().map((t) => t.name)).toEqual(['minimal', 'static']);
	});

	// `templates/server` holds the provisioning scripts, not a scaffoldable project.
	test('ignores template directories without a manifest', () => {
		expect(fs.existsSync(path.join(templatesDir(), 'server'))).toBe(true);
		expect(listProjectTemplates().map((t) => t.name)).not.toContain('server');
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

describe('package.template.json overrides', () => {
	// vite lists @vitejs/devtools as an optional peer, and devtools-vitest peers on
	// vitest@*. npm 10 still walks that peer set and, now that vitest@* resolves to
	// 5.x, crashes against the template's vitest 4. Pinning every vitest edge to the
	// root spec keeps npm 10 installs working (npm 11 resolves it on its own).
	test('minimal pins vitest so npm 10 does not pull vitest 5 via @vitejs/devtools', () => {
		const pkg = readTemplatePackage('minimal');
		expect(pkg.overrides?.vitest).toBe(pkg.devDependencies?.vitest);
	});

	// npm refuses to install when an override for a direct dependency differs from
	// its declared spec (EOVERRIDE), so bumping one without the other breaks every
	// `vela create`. A `$vitest` reference would track the spec automatically, but
	// npm 10 only resolves `$` references against `dependencies`, not
	// `devDependencies`, so the literal has to be kept in sync by hand.
	test('every override for a direct dependency matches its declared spec', () => {
		for (const template of listProjectTemplates()) {
			const pkg = readTemplatePackage(template.name);
			for (const [name, spec] of Object.entries(pkg.overrides ?? {})) {
				const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
				if (declared === undefined) continue;
				expect(spec, `${template.name}: override for ${name}`).toBe(declared);
			}
		}
	});
});

function readTemplatePackage(name: string): {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	overrides?: Record<string, string>;
} {
	const file = path.join(findProjectTemplate(name).dir, 'package.template.json');
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}
