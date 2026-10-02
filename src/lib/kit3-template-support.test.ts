import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { findKit3Blocker, kit3BlockerMessage } from './kit3-template-support.ts';

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-kit3-support-'));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function template(
	deps: Record<string, string>,
	files: Record<string, string> = {},
	manifest = 'package.template.json'
) {
	fs.writeFileSync(
		path.join(dir, manifest),
		JSON.stringify({ name: '~TODO~', dependencies: deps, devDependencies: { vela: '^0.14.5' } })
	);
	for (const [rel, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), text);
	}
}

const page = (imports: string) => `<script lang="ts">\n\t${imports}\n</script>\n`;

describe('findKit3Blocker', () => {
	test('refuses @velastack/cms ^0.4.0', () => {
		template({ '@velastack/cms': '^0.4.0' }, { 'src/routes/+page.svelte': page('') });
		expect(findKit3Blocker(dir)).toEqual({ cmsRange: '^0.4.0' });
	});

	test('allows @velastack/cms ^0.6.0', () => {
		template(
			{ '@velastack/cms': '^0.6.0' },
			{ 'src/routes/+page.svelte': page("import { CmsText } from '@velastack/cms';") }
		);
		expect(findKit3Blocker(dir)).toBeNull();
	});

	test('allows a template already on @velastack/cms ^0.5.1 without CmsRepeater', () => {
		template(
			{ '@velastack/cms': '^0.5.1' },
			{ 'src/lib/c.svelte': page("import { CmsContact, CmsHours } from '@velastack/cms';") }
		);
		expect(findKit3Blocker(dir)).toBeNull();
	});

	test('allows a template without @velastack/cms', () => {
		template({ 'bits-ui': '^2.0.0' }, { 'src/routes/+page.svelte': page('') });
		expect(findKit3Blocker(dir)).toBeNull();
	});

	test('refuses a CmsRepeater import even on a ^0.5 range', () => {
		template(
			{ '@velastack/cms': '^0.5.0' },
			{
				'src/routes/(public)/+page.svelte': page(
					"import { CmsRepeater, CmsText, cms } from '@velastack/cms';"
				)
			}
		);
		expect(findKit3Blocker(dir)).toEqual({
			repeaterFile: path.join('src', 'routes', '(public)', '+page.svelte')
		});
	});

	test('finds a multi-line or type-only CmsRepeater import', () => {
		template(
			{ '@velastack/cms': '^0.5.1' },
			{
				'src/lib/blocks.ts':
					"import type {\n\tCmsText,\n\tCmsRepeater\n} from '@velastack/cms/components';\n"
			}
		);
		expect(findKit3Blocker(dir)?.repeaterFile).toBe(path.join('src', 'lib', 'blocks.ts'));
	});

	test('ignores CmsRepeater outside an @velastack/cms import', () => {
		template(
			{ '@velastack/cms': '^0.6.0' },
			{
				'src/lib/Repeater.svelte': page("import { CmsRepeater } from './CmsRepeater.svelte';"),
				'src/lib/notes.ts': '// CmsRepeater was removed in @velastack/cms 0.5\n'
			}
		);
		expect(findKit3Blocker(dir)).toBeNull();
	});

	test('reads package.json when there is no package.template.json', () => {
		template({ '@velastack/cms': '~0.4.2' }, {}, 'package.json');
		expect(findKit3Blocker(dir)).toEqual({ cmsRange: '~0.4.2' });
	});

	test('does not refuse a range that names no version', () => {
		template({ '@velastack/cms': 'workspace:*' });
		expect(findKit3Blocker(dir)).toBeNull();
	});
});

describe('kit3BlockerMessage', () => {
	test('names the template, the reason and the SvelteKit 2 way out', () => {
		const message = kit3BlockerMessage('hearth', { cmsRange: '^0.4.0', repeaterFile: 'x' });
		expect(message).toContain("Template hearth hasn't been updated for SvelteKit 3 yet");
		expect(message).toContain('it uses CmsRepeater, which @velastack/cms 0.5 removed');
		expect(message).toContain('Pick another template');
		expect(message).toContain('npx vela@0.14 create --template hearth');
	});

	test('names the range when no CmsRepeater import was found', () => {
		expect(kit3BlockerMessage('kerf', { cmsRange: '^0.4.0' })).toContain(
			'it depends on @velastack/cms ^0.4.0'
		);
	});
});
