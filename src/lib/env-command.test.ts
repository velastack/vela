import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as p from '@clack/prompts';
import {
	applyLayerRestart,
	describeScope,
	knownScopes,
	parseEnvScope,
	serversFor,
	shadowWarning,
	type LayerContext
} from './env-command.ts';
import { layerFiles } from './env-scopes.ts';
import { serializeEnv } from './remote-env.ts';
import type { InstanceState } from './remote.ts';
import type { SshSession } from './ssh.ts';
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

describe('applyLayerRestart', () => {
	const APP = 'zdyly4bg3wuwr5x';
	const prod = { appId: APP, instance: APP, env: 'prod' } as InstanceState;
	const staging = { appId: APP, instance: `${APP}--staging`, env: 'staging' } as InstanceState;

	/** A server with these env files, counting which instances get restarted. */
	function server(files: Record<string, Record<string, string>>) {
		const store = new Map(Object.entries(files).map(([f, env]) => [f, serializeEnv(env)]));
		const restarted: string[] = [];
		const session = {
			readFile: async (file: string) => store.get(file) ?? null,
			script: async (_script: string, options: { args: string[] }) => {
				restarted.push(options.args[0]!);
				return { exitCode: 0, stdout: '', stderr: '' };
			}
		} as unknown as SshSession;
		const ctx: LayerContext = {
			kind: 'layer',
			workspaceRootDir: '/nowhere',
			layer: 'all',
			session,
			server: 'root@prod',
			appId: APP,
			files: layerFiles(APP, 'all'),
			reached: [prod, staging]
		};
		return { ctx, restarted };
	}

	let warn: ReturnType<typeof vi.spyOn>;
	let success: ReturnType<typeof vi.spyOn>;
	let info: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
		success = vi.spyOn(p.log, 'success').mockImplementation(() => {});
		info = vi.spyOn(p.log, 'info').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('an instance that sets the key itself is warned about, not restarted', async () => {
		const { ctx, restarted } = server({
			[layerFiles(APP, 'instance', APP).secret]: { KEY: 'mine' }
		});
		await applyLayerRestart(ctx, ['KEY']);

		expect(restarted).toEqual([staging.instance]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]![0])).toContain('vela env unset KEY -t production');
		expect(info.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
			expect.stringContaining('prod not restarted')
		]);
		expect(success.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
			expect.stringContaining('staging restarted')
		]);
	});

	test('a partly shadowed change still restarts, since the rest reaches', async () => {
		const { ctx, restarted } = server({
			[layerFiles(APP, 'instance', APP).public]: { KEY: 'mine' }
		});
		await applyLayerRestart(ctx, ['KEY', 'FREE']);

		expect(restarted).toEqual([prod.instance, staging.instance]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(info).not.toHaveBeenCalled();
	});
});

describe('shadowWarning', () => {
	test('names the layer that wins and how to stop it', () => {
		const prod = { appId: 'a', instance: 'a', env: 'prod' } as InstanceState;
		// The hint is colored, so the text is checked in pieces.
		const warning = shadowWarning(prod, 'all', { KEY: 'instance' });
		expect(warning).toContain('prod sets KEY itself, which wins over all.\n');
		expect(warning).toContain('To use the all value there: ');
		expect(warning).toContain('vela env unset KEY -t production');
		const staging = { ...prod, env: 'staging' };
		expect(shadowWarning(staging, 'all', { A: 'instance', B: 'instance' })).toContain(
			'vela env unset <key> -t staging'
		);
	});

	test('a preview instance gets the layer named, and a hint only for the preview layer', () => {
		const preview = { appId: 'a', instance: 'a--preview--x', env: 'preview--x', preview: true };
		expect(shadowWarning(preview as InstanceState, 'all', { KEY: 'preview' })).toContain(
			'vela env unset KEY -t preview'
		);
		const own = shadowWarning(preview as InstanceState, 'all', { KEY: 'instance' });
		expect(own).toContain('preview--x sets KEY itself');
		expect(own).not.toContain('vela env unset');
	});
});
