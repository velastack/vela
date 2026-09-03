import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	appendShadcnVariants,
	ensureShadcnVariants,
	hasShadcnVariants,
	shadcnVariantsBlock
} from './app-css.ts';
import { listProjectTemplates } from './templates.ts';

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-app-css-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('shadcnVariantsBlock', () => {
	// A truncated copy would silently break the components that use these.
	test('carries every variant, the keyframes and the utility shadcn-svelte defines', () => {
		const block = shadcnVariantsBlock();
		for (const variant of [
			'data-open',
			'data-closed',
			'data-checked',
			'data-unchecked',
			'data-disabled',
			'data-active',
			'data-horizontal',
			'data-vertical'
		]) {
			expect(block).toContain(`@custom-variant ${variant} {`);
		}
		expect(block).toContain('@utility no-scrollbar');
		expect(block).toContain('@keyframes accordion-down');
		expect(block).toContain('@keyframes accordion-up');
	});

	// `vela create` copies app.css, `vela bless` appends to it: both have to
	// produce the same block, so the templates must embed this exact file.
	test('is already part of every project template', () => {
		for (const template of listProjectTemplates()) {
			const css = fs.readFileSync(path.join(template.dir, 'src', 'app.css'), 'utf8');
			expect(hasShadcnVariants(css)).toBe(true);
			expect(css).toContain(shadcnVariantsBlock().trim());
		}
	});
});

describe('appendShadcnVariants', () => {
	test('separates the block with one blank line and ends with a newline', () => {
		const out = appendShadcnVariants(
			'@import "tailwindcss";\n\n\n',
			'@custom-variant data-open {}\n'
		);
		expect(out).toBe('@import "tailwindcss";\n\n@custom-variant data-open {}\n');
	});
});

describe('ensureShadcnVariants', () => {
	test('appends once and leaves the file alone afterwards', () => {
		const file = path.join(tmp, 'app.css');
		fs.writeFileSync(file, "@import 'tailwindcss';\n");

		expect(ensureShadcnVariants(file)).toBe(true);
		const once = fs.readFileSync(file, 'utf8');
		expect(hasShadcnVariants(once)).toBe(true);
		expect(once.startsWith("@import 'tailwindcss';\n\n")).toBe(true);

		expect(ensureShadcnVariants(file)).toBe(false);
		expect(fs.readFileSync(file, 'utf8')).toBe(once);
	});

	test('does nothing for a missing file', () => {
		expect(ensureShadcnVariants(path.join(tmp, 'nope.css'))).toBe(false);
	});
});
