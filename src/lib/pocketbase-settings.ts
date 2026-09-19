import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import PocketBase from 'pocketbase';
import { DATA_DIR, MIGRATIONS_DIR } from './constants.ts';
import { authWithRetries, startPocketbaseServe } from './pocketbase.ts';
import { withRemotePocketbase } from './remote-pocketbase.ts';
import type { SshSession } from './ssh.ts';

/**
 * Mail settings a new deployment inherits from the project's own database.
 *
 * Deliberately not everything under `meta`: `appURL` is per-deployment, and
 * `appName` comes from `src/lib/site.ts` rather than any database. The rest of
 * PocketBase's settings — smtp, s3, backups — is either credentials or an
 * endpoint belonging to whichever machine it was configured on. Copying those
 * would push a developer's mail account into production silently.
 */
const COPIED_KEYS = ['senderName', 'senderAddress'] as const;

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

/** The `meta` keys a fresh deployment takes from the project's own database. */
export function copiedMeta(local: Meta | null): Meta {
	const copied: Meta = {};
	for (const key of COPIED_KEYS) {
		const value = local?.[key];
		if (typeof value === 'string' && value.trim()) copied[key] = value;
	}
	return copied;
}

/**
 * Bring a deployment's PocketBase `meta` in line with `patch`, writing only the
 * keys whose value differs, and say what `appURL` it then has.
 *
 * Empty values in `patch` are skipped rather than written. Throws when the
 * database can't be reached; the deploy has already succeeded by then, so
 * callers report that rather than fail.
 */
export async function syncRemoteMeta(
	session: SshSession,
	instance: string,
	patch: Meta
): Promise<{ written: string[]; appURL: string | null }> {
	const wanted = Object.fromEntries(
		Object.entries(patch).filter(([, value]) => typeof value === 'string' && value.trim())
	);
	let written: string[] = [];
	let appURL: string | null = null;

	await withRemotePocketbase(session, instance, async (pb) => {
		const settings = (await pb.settings.getAll()) as { meta?: Meta };
		const meta = settings.meta ?? {};
		const changed = Object.fromEntries(
			Object.entries(wanted).filter(([key, value]) => meta[key] !== value)
		);
		written = Object.keys(changed);
		if (written.length > 0) {
			// Merged rather than replaced: `meta` carries fields this does not set,
			// and PocketBase would take a bare object as the whole of it.
			await pb.settings.update({ meta: { ...meta, ...changed } });
		}
		const value = { ...meta, ...changed }.appURL;
		appURL = typeof value === 'string' && value.trim() ? value : null;
	});

	return { written, appURL };
}
