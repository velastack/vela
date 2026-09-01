import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { normalizeOrigin, resolveOrigin } from './origin.ts';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-origin-'));
	delete process.env.VELA_ORIGIN;
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	delete process.env.VELA_ORIGIN;
});

function writeProject(contents: object): void {
	fs.mkdirSync(path.join(root, '.vela'), { recursive: true });
	fs.writeFileSync(path.join(root, '.vela', 'project.json'), JSON.stringify(contents, null, 2));
}

describe('normalizeOrigin', () => {
	test('adds the scheme Caddy terminates', () => {
		expect(normalizeOrigin('velastack.dev')).toBe('https://velastack.dev');
	});

	test('keeps a scheme that is already there', () => {
		expect(normalizeOrigin('http://127.0.0.1:4100')).toBe('http://127.0.0.1:4100');
		expect(normalizeOrigin('https://velastack.dev')).toBe('https://velastack.dev');
	});

	test('takes the first of the comma-separated hosts Caddy serves', () => {
		expect(normalizeOrigin('velastack.dev, www.velastack.dev')).toBe('https://velastack.dev');
	});

	test('drops path and trailing slash', () => {
		expect(normalizeOrigin('https://velastack.dev/')).toBe('https://velastack.dev');
		expect(normalizeOrigin('https://velastack.dev/docs')).toBe('https://velastack.dev');
	});

	test('is null for anything that cannot be an origin', () => {
		expect(normalizeOrigin(undefined)).toBeNull();
		expect(normalizeOrigin(null)).toBeNull();
		expect(normalizeOrigin('')).toBeNull();
		expect(normalizeOrigin('   ')).toBeNull();
		expect(normalizeOrigin(',')).toBeNull();
		expect(normalizeOrigin('https://')).toBeNull();
	});
});

describe('resolveOrigin', () => {
	test('reads the domain bound to the target', () => {
		writeProject({
			appId: 'zdyly4bg3wuwr5x',
			targets: {
				prod: { server: 'root@1.2.3.4', domain: 'velastack.dev' },
				staging: { server: 'root@1.2.3.4', domain: 'staging.velastack.dev' }
			}
		});

		expect(resolveOrigin(root, 'prod')).toBe('https://velastack.dev');
		expect(resolveOrigin(root, 'staging')).toBe('https://staging.velastack.dev');
	});

	test('the binding outranks the config file', () => {
		writeProject({
			appId: 'zdyly4bg3wuwr5x',
			targets: { prod: { server: 'root@1.2.3.4', domain: 'velastack.dev' } }
		});

		expect(resolveOrigin(root, 'prod', { deploy: { domain: 'example.com' } })).toBe(
			'https://velastack.dev'
		);
	});

	test('falls back to the config file when the target has no domain', () => {
		writeProject({
			appId: 'zdyly4bg3wuwr5x',
			targets: { staging: { server: 'root@1.2.3.4' } }
		});

		expect(resolveOrigin(root, 'staging', { deploy: { domain: 'example.com' } })).toBe(
			'https://example.com'
		);
	});

	test('VELA_ORIGIN wins, so CI can say what the build is for', () => {
		writeProject({
			appId: 'zdyly4bg3wuwr5x',
			targets: { prod: { server: 'root@1.2.3.4', domain: 'velastack.dev' } }
		});
		process.env.VELA_ORIGIN = 'https://preview.velastack.dev';

		expect(resolveOrigin(root, 'prod')).toBe('https://preview.velastack.dev');
	});

	test('is null when nothing configures a domain', () => {
		writeProject({ appId: 'zdyly4bg3wuwr5x' });

		expect(resolveOrigin(root, 'prod')).toBeNull();
		expect(resolveOrigin(root, 'prod', {})).toBeNull();
	});
});
