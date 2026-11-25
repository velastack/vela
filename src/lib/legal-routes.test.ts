import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { missingLegalSteps } from './legal-routes.ts';

describe('missingLegalSteps', () => {
	let tmp: string;
	const page = (route: string) => {
		const dir = path.join(tmp, 'src', 'routes', route);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, '+page.svelte'), '');
	};

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-legal-routes-'));
		fs.writeFileSync(path.join(tmp, 'package.json'), '{}\n');
		page('(public)');
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('names both commands when neither page exists', () => {
		const [step, ...rest] = missingLegalSteps(tmp);
		expect(rest).toEqual([]);
		expect(step).toContain('/terms and /privacy');
		expect(step).toContain('`vela legal terms` and `vela legal privacy`');
	});

	test('names only the page that is missing', () => {
		page('(legal)/terms');
		const [step] = missingLegalSteps(tmp);
		expect(step).toContain('/privacy, which does not exist yet');
		expect(step).toContain('`vela legal privacy` to write it');
		expect(step).not.toContain('vela legal terms');
	});

	test('says nothing once both exist, wherever they live', () => {
		page('(legal)/terms');
		page('(public)/privacy');
		expect(missingLegalSteps(tmp)).toEqual([]);
	});

	test('says nothing outside a project', () => {
		expect(missingLegalSteps(null)).toEqual([]);
	});
});
