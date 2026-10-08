import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { describeScope, knownScopes, parseEnvScope, serversFor } from './env-command.ts';
import { TargetError } from './target.ts';

describe('parseEnvScope', () => {
	test('nothing given is nothing chosen', () => {
		expect(parseEnvScope(undefined)).toBeNull();
		expect(parseEnvScope('  ')).toBeNull();
	});

	test('the two shared layers, and a bare preview is the layer, not a branch', () => {
		expect(parseEnvScope('all')).toEqual({ kind: 'all' });
		expect(parseEnvScope('ALL')).toEqual({ kind: 'all' });
		expect(parseEnvScope('preview')).toEqual({ kind: 'preview' });
	});

	test('everything else is a target, read the way every other command reads it', () => {
		expect(parseEnvScope('local')).toEqual({ kind: 'local' });
		expect(parseEnvScope('production')).toEqual({
			kind: 'instance',
			target: { kind: 'remote', name: 'production', envTag: 'prod' }
		});
		const preview = parseEnvScope('preview:feature/maps');
		expect(preview?.kind).toBe('instance');
		expect(preview && describeScope(preview)).toBe('preview:feature/maps');
		expect(() => parseEnvScope('root@1.2.3.4')).toThrow(TargetError);
	});
});

describe('scopes from bindings', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-env-scopes-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function writeProject(targets: Record<string, { server: string; domain?: string }>): void {
		fs.mkdirSync(path.join(root, '.vela'), { recursive: true });
		fs.writeFileSync(
			path.join(root, '.vela', 'project.json'),
			JSON.stringify({ appId: 'zdyly4bg3wuwr5x', targets }, null, 2)
		);
	}

	test('all reaches each distinct server once; preview only the preview binding', () => {
		writeProject({
			prod: { server: 'root@prod', domain: 'acme.com' },
			staging: { server: 'root@prod' },
			preview: { server: 'root@previews' }
		});
		expect(serversFor(root, 'all')).toEqual(['root@prod', 'root@previews']);
		expect(serversFor(root, 'preview')).toEqual(['root@previews']);
	});

	test('with no bindings there is nowhere to write', () => {
		expect(serversFor(root, 'all')).toEqual([]);
		expect(serversFor(root, 'preview')).toEqual([]);
	});

	test('the scopes a prompt offers: local, the layers, then each bound target by its name', () => {
		writeProject({ prod: { server: 'a' }, staging: { server: 'a' }, preview: { server: 'b' } });
		expect(knownScopes(root)).toEqual(['local', 'all', 'preview', 'production', 'staging']);
	});
});
