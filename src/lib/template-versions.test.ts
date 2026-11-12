import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { VERSIONS } from '@velastack/patterns';
import { minVersion, compareVersions } from './package-json.ts';
import { listProjectTemplates } from './templates.ts';

/**
 * `@velastack/patterns` decides every dependency range a vela project starts
 * from (its `versions.json`). The templates here are a copy of that list; when
 * this fails, run `npm run sync-versions`.
 */
describe('template dependency ranges', () => {
	test('patterns exports its version list', () => {
		expect(Object.keys(VERSIONS ?? {}).length).toBeGreaterThan(20);
	});

	for (const template of listProjectTemplates()) {
		test(`${template.name} lists the ranges patterns does`, () => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(template.dir, 'package.template.json'), 'utf8')
			);
			const drift: string[] = [];
			for (const kind of ['dependencies', 'devDependencies'] as const) {
				for (const [name, range] of Object.entries<string>(pkg[kind] ?? {})) {
					if (range.includes('~VELA_VERSION~')) continue;
					if (VERSIONS[name] !== range) {
						drift.push(`${name}: ${range} (patterns: ${VERSIONS[name] ?? 'not listed'})`);
					}
				}
			}
			expect(drift).toEqual([]);
		});
	}
});

/**
 * `vela migrate` raises a project to the floors SvelteKit 3 needs. Those are
 * minimums, so they may sit below what a new project starts on, never above:
 * a migrated project would then be ahead of a freshly created one.
 */
describe('migrate floors', () => {
	test('none is above the range a new project starts on', () => {
		const source = fs.readFileSync(path.join(import.meta.dirname, 'kit3-migrate.ts'), 'utf8');
		const block = /const FLOORS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source)![1]!;
		const literals = [...block.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)];
		expect(literals.length).toBeGreaterThan(5);
		const above: string[] = [];
		for (const [, name, range] of literals) {
			const listed = VERSIONS[name!];
			if (listed === undefined) continue;
			if (compareVersions(minVersion(range!)!, minVersion(listed)!) > 0) {
				above.push(`${name}: floor ${range}, new projects ${listed}`);
			}
		}
		expect(above).toEqual([]);
	});
});
