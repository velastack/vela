import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { compareVersions, minVersion, rangeAdmits, type PkgJson } from './package-json.ts';

/**
 * Third-party packages whose `@sveltejs/kit` peer still stops at SvelteKit 2
 * (`@icons-pack/svelte-simple-icons@7.2.0` peers `^2.5.0`). npm refuses the
 * install over them with an ERESOLVE that is hard to read, so the migration
 * finds them first and overrides the peer.
 */

/** What a lookup needs of a package version's manifest. */
export interface PeerManifest {
	version: string;
	peerDependencies?: Record<string, string>;
}

/**
 * The newest version of `name` that `range` admits, as the registry has it;
 * null when there is none. Throws when the registry cannot be asked.
 */
export type PeerLookup = (name: string, range: string, cwd: string) => Promise<PeerManifest | null>;

export interface Kit2Peer {
	name: string;
	/** The version checked. */
	version: string;
	/** Its `@sveltejs/kit` peer range. */
	peer: string;
}

export interface Kit2PeerScan {
	kit2: Kit2Peer[];
	/** Packages the registry could not be asked about. */
	unchecked: string[];
}

const LOOKUP_TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;
/** Failures in a row, with no answer yet, that mean the registry is out of reach. */
const OFFLINE_AFTER = 3;

/** `npm view <name>@<range> --json`, in the project so its .npmrc applies. */
export const npmViewLookup: PeerLookup = (name, range, cwd) =>
	new Promise((resolve, reject) => {
		execFile(
			'npm',
			['view', `${name}@${range}`, '--json'],
			{ cwd, timeout: LOOKUP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				// No such package, or no version in range: the registry answered.
				if (error && /\bE404\b/.test(`${stderr}${error.message}`)) return resolve(null);
				if (error) return reject(error);
				const text = stdout.trim();
				if (!text) return resolve(null);
				try {
					resolve(newest(JSON.parse(text) as PeerManifest | PeerManifest[]));
				} catch (e) {
					reject(e);
				}
			}
		);
	});

/** One manifest per matching version when the range admits several. */
function newest(data: PeerManifest | PeerManifest[]): PeerManifest | null {
	const list = (Array.isArray(data) ? data : [data]).filter((m) => typeof m?.version === 'string');
	let best: PeerManifest | null = null;
	for (const manifest of list) {
		const v = minVersion(manifest.version);
		const b = best ? minVersion(best.version) : null;
		if (v && (!b || compareVersions(v, b) > 0)) best = manifest;
	}
	return best;
}

/** The installed copy's manifest, when node_modules has one. */
function installed(root: string, name: string): PeerManifest | null {
	try {
		const data = JSON.parse(
			fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')
		) as PeerManifest;
		return typeof data.version === 'string' ? data : null;
	} catch {
		return null;
	}
}

/**
 * The direct dependencies of `pkg` (minus `skip`) whose `@sveltejs/kit` peer
 * does not admit 3.0.0. Each is read from node_modules when it is installed,
 * else from the registry, a few at a time; once the registry has failed a few
 * times without answering, the rest are not tried and come back unchecked.
 */
export async function findKit2Peers(
	root: string,
	pkg: PkgJson,
	skip: (name: string) => boolean,
	lookup: PeerLookup = npmViewLookup
): Promise<Kit2PeerScan> {
	const deps = new Map<string, string>();
	for (const kind of ['dependencies', 'devDependencies'] as const) {
		for (const [name, range] of Object.entries(pkg[kind] ?? {})) {
			if (!skip(name)) deps.set(name, range);
		}
	}

	const kit2: Kit2Peer[] = [];
	const unchecked: string[] = [];
	const check = (name: string, manifest: PeerManifest) => {
		const peer = manifest.peerDependencies?.['@sveltejs/kit'];
		if (peer && rangeAdmits(peer, '3.0.0') === false) {
			kit2.push({ name, version: manifest.version, peer });
		}
	};

	const remote: Array<[string, string]> = [];
	for (const [name, range] of deps) {
		const local = installed(root, name);
		if (local) check(name, local);
		// A range the registry cannot answer for (a path, a git URL, a workspace) is not looked up.
		else if (!range.includes(':') && !range.includes('/')) remote.push([name, range]);
	}

	let answered = 0;
	let failed = 0;
	const queue = [...remote];
	const worker = async () => {
		for (let next = queue.shift(); next; next = queue.shift()) {
			const [name, range] = next;
			if (answered === 0 && failed >= OFFLINE_AFTER) {
				unchecked.push(name);
				continue;
			}
			try {
				const manifest = await lookup(name, range, root);
				answered++;
				if (manifest) check(name, manifest);
				else unchecked.push(name);
			} catch {
				failed++;
				unchecked.push(name);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, remote.length) }, worker));

	const order = [...deps.keys()];
	const byOrder = (a: string, b: string) => order.indexOf(a) - order.indexOf(b);
	kit2.sort((a, b) => byOrder(a.name, b.name));
	unchecked.sort(byOrder);
	return { kit2, unchecked };
}
