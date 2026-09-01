import fs from 'node:fs';
import path from 'node:path';
import type PocketBase from 'pocketbase';
import { DATA_DIR } from './constants.ts';
import { remotePaths } from './remote.ts';
import type { SshSession } from './ssh.ts';

export interface S3Config {
	endpoint: string;
	bucket: string;
	region: string;
	accessKey: string;
	secret: string;
	forcePathStyle: boolean;
}

/** Which of PocketBase's two independent S3 configurations to write. */
export type S3Filesystem = 'storage' | 'backups';

/**
 * Providers that address buckets as a subdomain.
 *
 * Everything else — MinIO, Ceph, Garage, most self-hosted gateways — needs the
 * bucket in the path instead, and gets an opaque connection failure when it does
 * not. Guessing from the endpoint is right far more often than defaulting to
 * either answer outright.
 */
const VIRTUAL_HOSTED = [/\.amazonaws\.com$/i, /\.r2\.cloudflarestorage\.com$/i];

export function defaultForcePathStyle(endpoint: string): boolean {
	let host: string;
	try {
		host = new URL(endpoint).hostname;
	} catch {
		return false;
	}
	return !VIRTUAL_HOSTED.some((pattern) => pattern.test(host));
}

export async function applyS3(
	pb: PocketBase,
	config: S3Config,
	filesystem: S3Filesystem
): Promise<void> {
	const s3 = { enabled: true, ...config };
	await pb.settings.update(filesystem === 'backups' ? { backups: { s3 } } : { s3 });
}

export async function disableS3(pb: PocketBase, filesystem: S3Filesystem): Promise<void> {
	// Only `enabled` is sent: PocketBase merges settings, so the credentials stay
	// on record and turning it back on does not mean retyping them.
	const s3 = { enabled: false };
	await pb.settings.update(filesystem === 'backups' ? { backups: { s3 } } : { s3 });
}

export interface StoredS3 {
	enabled: boolean;
	endpoint: string;
	bucket: string;
	region: string;
	accessKey: string;
	forcePathStyle: boolean;
}

/**
 * Read back what is already configured, to pre-fill the prompts.
 *
 * The secret is never included — PocketBase strips it from the settings it
 * serves — so it is the one value that always has to be typed again.
 */
export async function readS3(pb: PocketBase, filesystem: S3Filesystem): Promise<StoredS3> {
	const settings = (await pb.settings.getAll()) as {
		s3?: Partial<StoredS3>;
		backups?: { s3?: Partial<StoredS3> };
	};
	const s3 = (filesystem === 'backups' ? settings.backups?.s3 : settings.s3) ?? {};
	return {
		enabled: s3.enabled === true,
		endpoint: s3.endpoint ?? '',
		bucket: s3.bucket ?? '',
		region: s3.region ?? '',
		accessKey: s3.accessKey ?? '',
		forcePathStyle: s3.forcePathStyle === true
	};
}

/**
 * Whether any upload is already sitting on local disk.
 *
 * Turning S3 on switches which filesystem PocketBase reads from; it moves
 * nothing. Every file already on disk stops resolving the moment it is enabled,
 * so this is the difference between a clean switch and a wall of broken images.
 *
 * The answer only has to be yes or no, so both paths stop at the first file
 * rather than counting a tree that may hold millions.
 */
export async function hasLocalUploads(
	session: SshSession | null,
	instance: string,
	workspaceRootDir: string
): Promise<boolean> {
	if (session) {
		const result = await session.script(`[ -d "$1" ] || exit 0; find "$1" -type f -print -quit`, {
			args: [remotePaths.storage(instance)]
		});
		return result.stdout.trim().length > 0;
	}
	return hasFile(path.join(workspaceRootDir, DATA_DIR, 'storage'));
}

function hasFile(dir: string): boolean {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		if (entry.isFile()) return true;
		if (entry.isDirectory() && hasFile(path.join(dir, entry.name))) return true;
	}
	return false;
}
