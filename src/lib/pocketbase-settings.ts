import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import PocketBase from 'pocketbase';
import { DATA_DIR, MIGRATIONS_DIR } from './constants.ts';
import { authWithRetries, startPocketbaseServe } from './pocketbase.ts';
import { withRemotePocketbase } from './remote-pocketbase.ts';
import type { SshSession } from './ssh.ts';

/**
 * Branding a new deployment inherits from the project's own database.
 *
 * Deliberately not everything under `meta`: `appURL` is per-deployment, and the
 * rest of PocketBase's settings — smtp, s3, backups — is either credentials or
 * an endpoint belonging to whichever machine it was configured on. Copying
 * those would push a developer's mail account into production silently.
 */
const COPIED_KEYS = ['appName', 'senderName', 'senderAddress'] as const;

type Meta = Record<string, unknown>;

/**
 * Read the project's own PocketBase settings.
 *
 * The database is a file, so this starts a server against it just long enough
 * to ask. Returns null whenever that is not possible — no backend, no database
 * yet, no superuser to authenticate as — because none of those are reasons to
 * fail a deploy that has already succeeded.
 */
export async function readLocalMeta(cwd: string): Promise<Meta | null> {
	const dataDir = path.join(cwd, DATA_DIR);
	if (!fs.existsSync(dataDir)) return null;

	const email = process.env.POCKETBASE_SUPERUSER_EMAIL;
	const password = process.env.POCKETBASE_SUPERUSER_PASSWORD;
	if (!email || !password) return null;

	let proc: { kill: () => void } | undefined;
	try {
		const started = await startPocketbaseServe({
			dataDir,
			migrationsDir: MIGRATIONS_DIR,
			hooksDir: path.join(dataDir, 'hooks')
		});
		proc = started.proc;

		const pb = new PocketBase(started.url);
		await authWithRetries(pb, email, password);
		const settings = (await pb.settings.getAll()) as { meta?: Meta };
		return settings.meta ?? null;
	} catch {
		return null;
	} finally {
		proc?.kill();
	}
}

/**
 * Read the `appURL` a deployment is currently telling itself it has.
 *
 * Only ever used to report a mismatch, so a database that cannot be reached is
 * not worth a word: the deploy has already succeeded either way.
 */
export async function readRemoteAppURL(
	session: SshSession,
	instance: string
): Promise<string | null> {
	try {
		let appURL: string | null = null;
		await withRemotePocketbase(session, instance, async (pb) => {
			const settings = (await pb.settings.getAll()) as { meta?: Meta };
			const value = settings.meta?.appURL;
			appURL = typeof value === 'string' && value.trim() ? value : null;
		});
		return appURL;
	} catch {
		return null;
	}
}

/**
 * Give a freshly created deployment the project's branding.
 *
 * Only ever called for a database this deploy created: re-running it would
 * overwrite whatever had since been set in the deployed admin panel, and the
 * deployed value is the one that should win from then on.
 */
export async function seedRemoteMeta(
	session: SshSession,
	instance: string,
	local: Meta,
	appURL: string
): Promise<string[]> {
	const patch: Meta = {};
	for (const key of COPIED_KEYS) {
		const value = local[key];
		if (typeof value === 'string' && value.trim()) patch[key] = value;
	}
	if (appURL) patch.appURL = appURL;
	if (Object.keys(patch).length === 0) return [];

	await withRemotePocketbase(session, instance, async (pb) => {
		const settings = (await pb.settings.getAll()) as { meta?: Meta };
		// Merged rather than replaced: `meta` carries fields this does not set,
		// and PocketBase would take a bare object as the whole of it.
		await pb.settings.update({ meta: { ...(settings.meta ?? {}), ...patch } });
	});

	return Object.keys(patch);
}
