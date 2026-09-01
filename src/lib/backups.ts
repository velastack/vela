import type PocketBase from 'pocketbase';
import { remotePaths, VELA_USER } from './remote.ts';
import type { SshSession } from './ssh.ts';

/**
 * What PocketBase will accept as a backup name.
 *
 * `apis/backup_create.go` matches this exactly and rejects anything else, which
 * rules out the `20260901T134501Z` stamp releases use — no uppercase.
 */
const BACKUP_KEY = /^[a-z0-9_-]+\.zip$/;

/** PocketBase caps the name at 150; the stamp and affixes take 24 of them. */
const MAX_SLUG = 100;

export interface BackupFile {
	key: string;
	size: number;
	modified: string;
}

export interface StorageSettings {
	/** Uploads are in a bucket, so a backup archive will not contain them. */
	s3Enabled: boolean;
	/** Backup archives go to a bucket rather than to `pb_data/backups`. */
	backupsS3Enabled: boolean;
}

export function isBackupKey(value: string): boolean {
	return BACKUP_KEY.test(value);
}

/**
 * Name a backup after the instance it came from.
 *
 * Deterministic on purpose: `createBackup` needs to be able to look the archive
 * up again after a request times out, and it has nothing else to look it up by.
 */
export function backupName(instance: string, now: Date = new Date()): string {
	const slug = instance
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_SLUG);
	const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
	return `vela_${slug || 'app'}_${stamp}.zip`;
}

export async function readStorageSettings(pb: PocketBase): Promise<StorageSettings> {
	const settings = (await pb.settings.getAll()) as {
		s3?: { enabled?: boolean };
		backups?: { s3?: { enabled?: boolean } };
	};
	return {
		s3Enabled: settings.s3?.enabled === true,
		backupsS3Enabled: settings.backups?.s3?.enabled === true
	};
}

export async function listBackups(pb: PocketBase): Promise<BackupFile[]> {
	const list = await pb.backups.getFullList();
	return [...list].sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * True when a request died because the client gave up waiting, not because the
 * server said no.
 *
 * `POST /api/backups` archives the whole data directory before it answers, and
 * Node's fetch stops waiting for headers after five minutes. On a large
 * instance that fires while PocketBase carries on and finishes successfully, so
 * it has to be told apart from a real failure.
 */
function isClientTimeout(error: unknown): boolean {
	for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
		const cause = e as { code?: string; name?: string; originalError?: unknown; cause?: unknown };
		if (cause.code === 'UND_ERR_HEADERS_TIMEOUT' || cause.name === 'HeadersTimeoutError')
			return true;
		e = cause.originalError ?? cause.cause;
	}
	return false;
}

const POLL_INTERVAL = 5_000;

/**
 * Take a backup, tolerating a request that outlives the client's patience.
 *
 * The name is chosen here rather than by PocketBase so that a timed-out request
 * can be resolved by asking whether the archive turned up — the alternative is
 * reporting a failure for a backup that actually exists.
 */
export async function createBackup(
	pb: PocketBase,
	key: string,
	{ pollTimeout = 30 * 60_000 }: { pollTimeout?: number } = {}
): Promise<void> {
	try {
		await pb.backups.create(key);
		return;
	} catch (error) {
		if (!isClientTimeout(error)) throw error;
	}

	const deadline = Date.now() + pollTimeout;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
		const found = await listBackups(pb).catch(() => [] as BackupFile[]);
		if (found.some((b) => b.key === key)) return;
	}

	throw new Error(
		`The backup request timed out and ${key} has not appeared after ` +
			`${Math.round(pollTimeout / 60_000)} minutes.\n\n` +
			`PocketBase may still be working on it — check \`vela logs\` and ` +
			`\`vela backup list\` before trying again.`
	);
}

/**
 * Fold any app-owned write-ahead log back into the database file it belongs to.
 *
 * PocketBase checkpoints the databases it owns before archiving `pb_data` — in
 * an archive its `-wal` files are empty. A database the app opened for itself
 * gets no such treatment: its `-wal` is copied as it was found, and a checkpoint
 * landing between the moments the archiver reads the two files leaves the pair
 * describing different instants.
 *
 * Every SQLite file in the directory is offered a checkpoint rather than a list
 * of the ones known to be app-owned: PocketBase's own are already flushed, so
 * the redundant work is one no-op each, and a guessed list is a list that goes
 * stale the first time a build adds a database to `pb_data`.
 *
 * Two things are deliberate. It runs as the app user, because a checkpoint run
 * as root recreates `-wal` and `-shm` owned by root and the app can no longer
 * write to its own database afterwards. And every step is best-effort: a
 * database busy enough to refuse is a database whose backup is slightly less
 * consistent, which is not worth failing the backup over.
 *
 * Remote only. Locally PocketBase and the app share a directory that no deploy
 * moves, `sqlite3` is not guaranteed to be installed, and a backup of a
 * development database is a convenience rather than a promise.
 */
export async function checkpointAppDatabases(session: SshSession, instance: string): Promise<void> {
	await session.script(
		`command -v sqlite3 >/dev/null 2>&1 || exit 0
		for db in "$1"/*.db "$1"/*.sqlite; do
			[ -f "$db-wal" ] || continue
			runuser -u "$2" -- sqlite3 "$db" \
				'PRAGMA busy_timeout=5000; PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true
		done`,
		{ args: [remotePaths.pbData(instance), VELA_USER], check: false }
	);
}

export function formatBytes(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export interface BackupSchedule {
	/** Empty when no automatic backup is scheduled. */
	cron: string;
	/** How many cron-generated archives PocketBase keeps. */
	maxKeep: number;
}

export async function readSchedule(pb: PocketBase): Promise<BackupSchedule> {
	const settings = (await pb.settings.getAll()) as {
		backups?: { cron?: string; cronMaxKeep?: number };
	};
	return {
		cron: settings.backups?.cron ?? '',
		maxKeep: settings.backups?.cronMaxKeep ?? 0
	};
}

/**
 * Set or clear the automatic backup schedule.
 *
 * PocketBase runs the cron itself, in the same process that serves the app, so
 * there is nothing to install on the server. `cronMaxKeep` is required and must
 * be at least 1 whenever a schedule is set, and it prunes only the archives the
 * cron made — anything from `vela backup create` is left alone.
 *
 * Only these two keys are sent: settings are merged, so an S3 backups bucket
 * configured alongside them survives untouched.
 */
export async function writeSchedule(pb: PocketBase, cron: string, maxKeep: number): Promise<void> {
	await pb.settings.update({ backups: { cron, cronMaxKeep: cron ? maxKeep : 0 } });
}
