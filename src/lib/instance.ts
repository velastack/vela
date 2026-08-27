/**
 * Instance identity.
 *
 * A deployed app is identified on the server by a single stable token that is
 * safe in a path, a systemd unit name, and a filename:
 *
 *   prod                -> `<appId>`
 *   staging             -> `<appId>--staging`
 *   preview/feature-x   -> `<appId>--preview--feature-x`
 *
 * Production deliberately has no suffix, so the common case reads as
 * `/var/lib/vela/apps/<appId>` — the layout `plans/vela-env-plan.md` describes.
 */

export const PROD_ENV = 'prod';

const MAX_SEGMENT = 48;

/** Normalize a user-supplied environment tag to its canonical form. */
export function normalizeEnvTag(tag: string | undefined): string {
	const raw = (tag ?? PROD_ENV).trim();
	if (!raw) return PROD_ENV;
	const normalized = raw
		.toLowerCase()
		.replace(/\//g, '--')
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-{3,}/g, '--')
		.replace(/^-+|-+$/g, '');
	if (!normalized) throw new Error(`Invalid environment tag: ${tag}`);
	// `local` is the copy on this machine and has no instance on any server.
	// Closed here rather than in the target parser so that no future caller can
	// route around it and create `<appId>--local`.
	if (normalized === 'local') {
		throw new Error('`local` is not a deployable environment — it is the copy on this machine.');
	}
	return normalized === 'production' ? PROD_ENV : normalized;
}

/** Turn a git branch name into an environment tag: `feature/auth` -> `preview--feature-auth`. */
export function branchToEnvTag(branch: string): string {
	const slug = branch
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_SEGMENT);
	return `preview--${slug}`;
}

export function instanceId(appId: string, envTag: string = PROD_ENV): string {
	const env = normalizeEnvTag(envTag);
	return env === PROD_ENV ? appId : `${appId}--${env}`;
}

export function isProd(envTag: string): boolean {
	return normalizeEnvTag(envTag) === PROD_ENV;
}

/** A release id sorts lexicographically by time, which is how `latest` is found. */
export function releaseId(date = new Date()): string {
	return date
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'Z');
}
