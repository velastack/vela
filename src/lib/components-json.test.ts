import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { componentsJsonHints, readComponentsJson } from './components-json.ts';
import { listProjectTemplates } from './templates.ts';

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-components-json-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('readComponentsJson', () => {
	test('returns undefined for a missing or unreadable file', () => {
		expect(readComponentsJson(tmp)).toBeUndefined();
		fs.writeFileSync(path.join(tmp, 'components.json'), '{ not json');
		expect(readComponentsJson(tmp)).toBeUndefined();
	});

	test('reads the config', () => {
		fs.writeFileSync(path.join(tmp, 'components.json'), JSON.stringify({ style: 'vega' }));
		expect(readComponentsJson(tmp)).toEqual({ style: 'vega' });
	});
});

describe('componentsJsonHints', () => {
	test('hints at both keys when neither is set', () => {
		const hints = componentsJsonHints({ tailwind: { css: 'src/app.css' } });
		expect(hints).toHaveLength(2);
		expect(hints[0]).toContain('"style": "vega"');
		expect(hints[1]).toContain('"iconLibrary": "lucide"');
	});

	test('is silent once both are set', () => {
		expect(componentsJsonHints({ style: 'nova', iconLibrary: 'lucide' })).toEqual([]);
	});

	// The templates are the reference config, so they must never trigger a hint.
	test('has nothing to say about the templates', () => {
		for (const template of listProjectTemplates()) {
			const config = readComponentsJson(template.dir)!;
			expect(config.style).toBe('vega');
			expect(componentsJsonHints(config)).toEqual([]);
		}
	});
});
