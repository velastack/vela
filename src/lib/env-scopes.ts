import { remotePaths, type InstanceState } from './remote.ts';
import { readRemoteEnvFile, writeRemoteEnvFile, type EnvRecord } from './remote-env.ts';
import type { SshSession } from './ssh.ts';

/**
 * The env an instance runs with is three layers, lowest to highest: the app-wide
 * one every target shares, the one every preview shares, and the instance's
 * own. Each is a pair of files, secret and public, and systemd reads them in
 * that order so a higher layer's value wins.
 */
export type Layer = 'all' | 'preview' | 'instance';

export type Visibility = 'secret' | 'public';

export interface LayerFiles {
	secret: string;
	public: string;
}

export function layerFiles(appId: string, layer: 'all' | 'preview'): LayerFiles;
export function layerFiles(appId: string, layer: 'instance', instance: string): LayerFiles;
export function layerFiles(appId: string, layer: Layer, instance?: string): LayerFiles {
	if (layer === 'instance') {
		return { secret: remotePaths.env(instance!), public: remotePaths.publicEnv(instance!) };
	}
	return {
		secret: remotePaths.scopeEnv(appId, layer),
		public: remotePaths.scopePublicEnv(appId, layer)
	};
}

/**
 * `PUBLIC_*` is public without being asked: SvelteKit ships those keys in the
 * browser bundle, so keeping them write-only on the server would hide nothing.
 */
export function isPublicKey(key: string): boolean {
	return key.startsWith('PUBLIC_');
}

export function visibilityFor(key: string, asPublic: boolean): Visibility {
	return asPublic || isPublicKey(key) ? 'public' : 'secret';
}

export interface LayerContents {
	secret: EnvRecord;
	public: EnvRecord;
}

/**
 * Both files of a layer. The secret file is read too, for its *names*: `list`
 * shows which keys exist, never what a secret holds. Callers that print values
 * take them from `public` alone.
 */
export async function readLayer(session: SshSession, files: LayerFiles): Promise<LayerContents> {
	return {
		secret: await readRemoteEnvFile(session, files.secret),
		public: await readRemoteEnvFile(session, files.public)
	};
}

export interface SetOutcome {
	visibility: Visibility;
	/** The key was in the other file and has been taken out of it. */
	moved: boolean;
}

/**
 * Set a key in one of a layer's files and make sure it is in only that one,
 * so setting a key again with or without `--public` is how it changes sides.
 */
export async function setInLayer(
	session: SshSession,
	files: LayerFiles,
	key: string,
	value: string,
	asPublic: boolean
): Promise<SetOutcome> {
	const visibility = visibilityFor(key, asPublic);
	const contents = await readLayer(session, files);
	const other = visibility === 'public' ? 'secret' : 'public';

	const target = { ...contents[visibility], [key]: value };
	await writeRemoteEnvFile(session, files[visibility], target);

	const moved = key in contents[other];
	if (moved) {
		const rest = { ...contents[other] };
		delete rest[key];
		await writeRemoteEnvFile(session, files[other], rest);
	}
	return { visibility, moved };
}

/** Remove a key from whichever of the layer's files has it. False when neither did. */
export async function unsetInLayer(
	session: SshSession,
	files: LayerFiles,
	key: string
): Promise<boolean> {
	const contents = await readLayer(session, files);
	let removed = false;
	for (const visibility of ['secret', 'public'] as const) {
		if (!(key in contents[visibility])) continue;
		const rest = { ...contents[visibility] };
		delete rest[key];
		await writeRemoteEnvFile(session, files[visibility], rest);
		removed = true;
	}
	return removed;
}

export interface ImportOutcome {
	public: string[];
	secret: string[];
}

/**
 * Merge a record into a layer: `PUBLIC_*` keys land public, everything else
 * where `asPublic` says, and a key already on the other side moves. Keys the
 * record does not mention stay as they were.
 */
export async function importIntoLayer(
	session: SshSession,
	files: LayerFiles,
	incoming: EnvRecord,
	asPublic: boolean
): Promise<ImportOutcome> {
	const contents = await readLayer(session, files);
	const next: LayerContents = { secret: { ...contents.secret }, public: { ...contents.public } };
	const outcome: ImportOutcome = { public: [], secret: [] };

	for (const [key, value] of Object.entries(incoming)) {
		const visibility = visibilityFor(key, asPublic);
		const other = visibility === 'public' ? 'secret' : 'public';
		next[visibility][key] = value;
		delete next[other][key];
		outcome[visibility].push(key);
	}

	for (const visibility of ['secret', 'public'] as const) {
		if (JSON.stringify(next[visibility]) !== JSON.stringify(contents[visibility])) {
			await writeRemoteEnvFile(session, files[visibility], next[visibility]);
		}
	}
	return outcome;
}

export interface ResolvedEntry {
	layer: Layer;
	visibility: Visibility;
	/** Only for public keys; a secret's value is never read into this. */
	value?: string;
}

export interface ResolvedStack {
	/** Public values only, keyed by name. */
	values: EnvRecord;
	/**
	 * Secret values, for a build that must see exactly what the server will.
	 * Held in memory and handed to a child process; never printed, never
	 * written locally. Commands that show the environment use `values` and
	 * `entries` alone.
	 */
	secrets: EnvRecord;
	/** Every key the instance will see from its three layers, with where it comes from. */
	entries: Record<string, ResolvedEntry>;
}

/** The layers an instance resolves, lowest to highest. */
export function layersFor(
	appId: string,
	instance: string,
	preview: boolean
): { layer: Layer; files: LayerFiles }[] {
	return [
		{ layer: 'all', files: layerFiles(appId, 'all') },
		...(preview ? [{ layer: 'preview' as const, files: layerFiles(appId, 'preview') }] : []),
		{ layer: 'instance', files: layerFiles(appId, 'instance', instance) }
	];
}

/**
 * What an instance's environment resolves to across its layers, the way
 * systemd will read it: later layers win. Secret values stay where they are;
 * the stack records that the key exists and which layer supplies it.
 */
export async function resolveStack(
	session: SshSession,
	appId: string,
	instance: string,
	preview: boolean
): Promise<ResolvedStack> {
	const values: EnvRecord = {};
	const secrets: EnvRecord = {};
	const entries: Record<string, ResolvedEntry> = {};
	for (const { layer, files } of layersFor(appId, instance, preview)) {
		const contents = await readLayer(session, files);
		for (const [key, value] of Object.entries(contents.secret)) {
			entries[key] = { layer, visibility: 'secret' };
			secrets[key] = value;
			delete values[key];
		}
		for (const [key, value] of Object.entries(contents.public)) {
			entries[key] = { layer, visibility: 'public', value };
			values[key] = value;
			delete secrets[key];
		}
	}
	return { values, secrets, entries };
}

/** The instances of this app on a server that a shared layer applies to. */
export function reachedInstances(
	states: InstanceState[],
	appId: string,
	layer: 'all' | 'preview'
): InstanceState[] {
	return states.filter(
		(state) => state.appId === appId && (layer === 'all' || state.preview === true)
	);
}
