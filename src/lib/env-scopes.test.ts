import { describe, expect, test } from 'vitest';
import {
	importIntoLayer,
	isPublicKey,
	layerFiles,
	layersFor,
	reachedInstances,
	resolveStack,
	setInLayer,
	unsetInLayer,
	visibilityFor
} from './env-scopes.ts';
import { parseEnv, serializeEnv } from './remote-env.ts';
import type { SshSession } from './ssh.ts';
import type { InstanceState } from './remote.ts';

/** A server whose env files are a map, with the same read/write shape `SshSession` has. */
function fakeSession(files: Record<string, Record<string, string>> = {}) {
	const store = new Map<string, string>();
	for (const [file, env] of Object.entries(files)) store.set(file, serializeEnv(env));
	const session = {
		readFile: async (file: string) => store.get(file) ?? null,
		writeFile: async (file: string, content: string) => {
			store.set(file, content);
		},
		script: async () => ({ exitCode: 0, stdout: '', stderr: '' })
	} as unknown as SshSession;
	const read = (file: string) => parseEnv(store.get(file) ?? '');
	return { session, read, has: (file: string) => store.has(file) };
}

const APP = 'zdyly4bg3wuwr5x';

describe('layerFiles', () => {
	test('shared layers live in their own tree, because production is named after the app', () => {
		expect(layerFiles(APP, 'all')).toEqual({
			secret: `/etc/vela/scopes/${APP}/all/env`,
			public: `/etc/vela/scopes/${APP}/all/env.public`
		});
		expect(layerFiles(APP, 'preview').secret).toBe(`/etc/vela/scopes/${APP}/preview/env`);
		expect(layerFiles(APP, 'instance', APP)).toEqual({
			secret: `/etc/vela/apps/${APP}/env`,
			public: `/etc/vela/apps/${APP}/env.public`
		});
	});
});

describe('visibility', () => {
	test('PUBLIC_* is public without being asked; everything else is secret unless asked', () => {
		expect(isPublicKey('PUBLIC_CMS_URL')).toBe(true);
		expect(visibilityFor('PUBLIC_CMS_URL', false)).toBe('public');
		expect(visibilityFor('WHATSAPP_MODE', false)).toBe('secret');
		expect(visibilityFor('WHATSAPP_MODE', true)).toBe('public');
	});
});

describe('setInLayer', () => {
	const files = layerFiles(APP, 'all');

	test('writes a secret to the secret file only', async () => {
		const { session, read, has } = fakeSession();
		const outcome = await setInLayer(session, files, 'STRIPE_SECRET_KEY', 'sk_live', false);
		expect(outcome).toEqual({ visibility: 'secret', moved: false });
		expect(read(files.secret)).toEqual({ STRIPE_SECRET_KEY: 'sk_live' });
		expect(has(files.public)).toBe(false);
	});

	test('moves a key between files when its visibility changes', async () => {
		const { session, read } = fakeSession({ [files.secret]: { WHATSAPP_MODE: 'dev', OTHER: 'x' } });
		const outcome = await setInLayer(session, files, 'WHATSAPP_MODE', 'velastack', true);
		expect(outcome).toEqual({ visibility: 'public', moved: true });
		expect(read(files.public)).toEqual({ WHATSAPP_MODE: 'velastack' });
		expect(read(files.secret)).toEqual({ OTHER: 'x' });
	});
});

describe('unsetInLayer', () => {
	const files = layerFiles(APP, 'instance', APP);

	test('removes from whichever side has it and reports a miss', async () => {
		const { session, read } = fakeSession({
			[files.secret]: { A: '1' },
			[files.public]: { PUBLIC_B: '2' }
		});
		expect(await unsetInLayer(session, files, 'PUBLIC_B')).toBe(true);
		expect(read(files.public)).toEqual({});
		expect(read(files.secret)).toEqual({ A: '1' });
		expect(await unsetInLayer(session, files, 'NOPE')).toBe(false);
	});
});

describe('importIntoLayer', () => {
	test('merges, sorts PUBLIC_* public, and leaves unmentioned keys alone', async () => {
		const files = layerFiles(APP, 'preview');
		const { session, read } = fakeSession({
			[files.secret]: { KEEP: 'kept', MOVES: 'old' }
		});
		const outcome = await importIntoLayer(
			session,
			files,
			{ PUBLIC_URL: 'https://x', TOKEN: 't', MOVES: 'new' },
			false
		);
		expect(outcome).toEqual({ public: ['PUBLIC_URL'], secret: ['TOKEN', 'MOVES'] });
		expect(read(files.secret)).toEqual({ KEEP: 'kept', MOVES: 'new', TOKEN: 't' });
		expect(read(files.public)).toEqual({ PUBLIC_URL: 'https://x' });
	});
});

describe('resolveStack', () => {
	test('a preview resolves all < preview < instance, later winning', async () => {
		const instance = `${APP}--preview--feat`;
		const all = layerFiles(APP, 'all');
		const preview = layerFiles(APP, 'preview');
		const own = layerFiles(APP, 'instance', instance);
		const { session } = fakeSession({
			[all.public]: { PUBLIC_A: 'all', PUBLIC_B: 'all' },
			[all.secret]: { SECRET: 'all' },
			[preview.public]: { PUBLIC_B: 'preview' },
			[own.secret]: { PUBLIC_A: 'made-secret' }
		});

		const stack = await resolveStack(session, APP, instance, true);
		expect(stack.values).toEqual({ PUBLIC_B: 'preview' });
		expect(stack.entries.PUBLIC_A).toEqual({ layer: 'instance', visibility: 'secret' });
		expect(stack.entries.PUBLIC_B).toEqual({
			layer: 'preview',
			visibility: 'public',
			value: 'preview'
		});
		expect(stack.entries.SECRET).toEqual({ layer: 'all', visibility: 'secret' });

		expect(stack.secrets).toEqual({ SECRET: 'all', PUBLIC_A: 'made-secret' });
	});

	test('a non-preview skips the preview layer', async () => {
		const preview = layerFiles(APP, 'preview');
		const { session } = fakeSession({ [preview.public]: { ONLY_PREVIEWS: '1' } });
		expect(layersFor(APP, APP, false).map((l) => l.layer)).toEqual(['all', 'instance']);
		expect((await resolveStack(session, APP, APP, false)).entries).toEqual({});
	});
});

describe('reachedInstances', () => {
	const states = [
		{ appId: APP, instance: APP, env: 'prod' },
		{ appId: APP, instance: `${APP}--staging`, env: 'staging' },
		{ appId: APP, instance: `${APP}--preview--x`, env: 'preview--x', preview: true },
		{ appId: 'other', instance: 'other', env: 'prod' }
	] as InstanceState[];

	test('all reaches every instance of the app; preview only its previews', () => {
		expect(reachedInstances(states, APP, 'all').map((s) => s.env)).toEqual([
			'prod',
			'staging',
			'preview--x'
		]);
		expect(reachedInstances(states, APP, 'preview').map((s) => s.env)).toEqual(['preview--x']);
	});
});
