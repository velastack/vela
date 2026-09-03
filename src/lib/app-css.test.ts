import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	SHADCN_TAILWIND_IMPORT,
	ensureShadcnImport,
	hasShadcnImport,
	insertShadcnImport
} from './app-css.ts';
import { listProjectTemplates } from './templates.ts';

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-app-css-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('hasShadcnImport', () => {
	// `vela create` copies app.css, `vela bless` inserts into it: both have to
	// end up with the import, so the templates must carry it.
	test('every project template carries the import', () => {
		for (const template of listProjectTemplates()) {
			const css = fs.readFileSync(path.join(template.dir, 'src', 'app.css'), 'utf8');
			expect(hasShadcnImport(css)).toBe(true);
			expect(css).toContain(SHADCN_TAILWIND_IMPORT);
		}
	});

	// The templates no longer inline the block, so a copy of it in a project
	// is a leftover from an older CLI and `shadcn-svelte apply` would add the
	// import beside it: two definitions of every variant.
	test('no template inlines the variants block any more', () => {
		for (const template of listProjectTemplates()) {
			const css = fs.readFileSync(path.join(template.dir, 'src', 'app.css'), 'utf8');
			expect(css).not.toContain('@custom-variant data-open');
		}
	});

	test('recognises the double-quoted form shadcn-svelte writes', () => {
		expect(hasShadcnImport('@import "shadcn-svelte/tailwind.css";\n')).toBe(true);
		expect(hasShadcnImport("@import 'tailwindcss';\n")).toBe(false);
	});
});

describe('insertShadcnImport', () => {
	test('goes after the last leading import', () => {
		const out = insertShadcnImport(
			"@import 'tailwindcss';\n@import 'tw-animate-css';\n@plugin '@tailwindcss/typography';\n\n:root {}\n"
		);
		expect(out).toBe(
			"@import 'tailwindcss';\n@import 'tw-animate-css';\n@import 'shadcn-svelte/tailwind.css';\n@plugin '@tailwindcss/typography';\n\n:root {}\n"
		);
	});

	test('skips comments and blank lines between imports', () => {
		const out = insertShadcnImport(
			"/* global styles */\n@import 'tailwindcss';\n\n@import 'tw-animate-css';\n\n:root {}\n"
		);
		expect(out).toBe(
			"/* global styles */\n@import 'tailwindcss';\n\n@import 'tw-animate-css';\n@import 'shadcn-svelte/tailwind.css';\n\n:root {}\n"
		);
	});

	test('does not treat a later import as part of the leading block', () => {
		const out = insertShadcnImport("@import 'tailwindcss';\n\n:root {}\n\n@import 'late.css';\n");
		expect(out).toBe(
			"@import 'tailwindcss';\n@import 'shadcn-svelte/tailwind.css';\n\n:root {}\n\n@import 'late.css';\n"
		);
	});

	test('goes first when there are no imports', () => {
		expect(insertShadcnImport(':root {}\n')).toBe(
			"@import 'shadcn-svelte/tailwind.css';\n:root {}\n"
		);
	});
});

describe('ensureShadcnImport', () => {
	test('inserts once and leaves the file alone afterwards', () => {
		const file = path.join(tmp, 'app.css');
		fs.writeFileSync(file, "@import 'tailwindcss';\n\n:root {}\n");

		expect(ensureShadcnImport(file)).toBe(true);
		const once = fs.readFileSync(file, 'utf8');
		expect(once).toBe(
			"@import 'tailwindcss';\n@import 'shadcn-svelte/tailwind.css';\n\n:root {}\n"
		);

		expect(ensureShadcnImport(file)).toBe(false);
		expect(fs.readFileSync(file, 'utf8')).toBe(once);
	});

	test('does nothing for a missing file', () => {
		expect(ensureShadcnImport(path.join(tmp, 'nope.css'))).toBe(false);
	});
});
