import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { VELA_ONLY_DIRS, VELA_ONLY_FILES } from './bless.ts';
import { findProjectTemplate, projectTemplateNames } from '../lib/templates.ts';
import { templateName } from '../lib/template-files.ts';
import { SITE_FILE } from '../lib/site.ts';

/** Project-relative paths bless puts in a project that has none of its own. */
function installedPaths(templateDir: string): Set<string> {
	const installed = new Set<string>();

	for (const file of VELA_ONLY_FILES) {
		if (fs.existsSync(path.join(templateDir, templateName(file.path)))) installed.add(file.path);
	}
	// writeSiteFile fills src/lib/site.template.ts into src/lib/site.ts.
	if (fs.existsSync(path.join(templateDir, templateName(SITE_FILE)))) installed.add(SITE_FILE);

	for (const dir of VELA_ONLY_DIRS) {
		const root = path.join(templateDir, dir);
		if (!fs.existsSync(root)) continue;
		for (const entry of fs.globSync('**/*', { cwd: root, withFileTypes: true })) {
			if (!entry.isFile() || entry.name === '.DS_Store') continue;
			const rel = path.relative(root, path.join(entry.parentPath, entry.name));
			installed.add(path.posix.join(dir, rel.split(path.sep).join('/')));
		}
	}
	return installed;
}

/** `$lib/...` specifiers imported by a source file. */
function libImports(source: string): string[] {
	const specifiers = source.matchAll(/from\s+'(\$lib\/[^']+)'/g);
	return [...new Set([...specifiers].map((match) => match[1]!))];
}

/** Whether `$lib/x` resolves to something in `installed`. */
function resolves(specifier: string, installed: Set<string>): boolean {
	const base = specifier.replace(/^\$lib\//, 'src/lib/');
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.js`,
		`${base}.svelte`,
		`${base}/index.ts`,
		`${base}/index.js`,
		// TypeScript resolves a `.js` specifier to the `.ts` file beside it.
		base.replace(/\.js$/, '.ts')
	];
	return candidates.some((candidate) => installed.has(candidate));
}

describe('bless installs a project that resolves', () => {
	// Only backend templates can be blessed.
	for (const name of projectTemplateNames({ backend: true })) {
		const templateDir = findProjectTemplate(name).dir;

		test(`${name}: every $lib import in an installed file is installed too`, () => {
			const installed = installedPaths(templateDir);
			const dangling: string[] = [];

			for (const rel of installed) {
				if (!/\.(ts|js|svelte)$/.test(rel)) continue;
				const file = path.join(templateDir, templateName(rel));
				if (!fs.existsSync(file)) continue;
				for (const specifier of libImports(fs.readFileSync(file, 'utf8'))) {
					if (!resolves(specifier, installed)) dangling.push(`${rel} -> ${specifier}`);
				}
			}

			expect(dangling).toEqual([]);
		});

		// The regression: hooks.server.ts starts the workflow worker, and bless
		// copied the hook without the module it imports, so a blessed project
		// did not type-check.
		test(`${name}: brings the workflow worker the hook starts`, () => {
			const installed = installedPaths(templateDir);
			const hook = path.join(templateDir, 'src/hooks.server.ts');
			if (!fs.existsSync(hook)) return;

			expect(fs.readFileSync(hook, 'utf8')).toContain("from '$lib/server/workflows'");
			expect(installed.has('src/lib/server/workflows.ts')).toBe(true);
		});
	}
});
