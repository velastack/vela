import crypto from 'node:crypto';

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

/**
 * What every id `instanceId()` produces looks like. The server scripts check
 * the same shape (`require_instance_id` in templates/server/lib.sh) before an
 * id reaches a path root removes; keep the two in step.
 */
export const INSTANCE_ID_RE = /^[a-z0-9]+(-{1,2}[a-z0-9]+)*$/;

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

/** Hex characters of the branch hash a lossy preview slug carries. */
const SLUG_HASH = 6;

/**
 * Turn a git branch name into an environment tag.
 *
 * `fix-copy` keeps its name: `preview--fix-copy`. A branch the slug cannot
 * spell back - punctuation folded, case folded, or cut at the length limit -
 * carries a short hash of the full name: `feature/auth` becomes
 * `preview--feature-auth-1a2b3c`. Without it `feature/x` and `feature-x`, or
 * two long Dependabot branches differing only past the limit, would share one
 * instance, and closing one pull request would remove the other's preview.
 */
export function branchToEnvTag(branch: string): string {
	const lower = branch.toLowerCase();
	const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	if (slug === branch && slug.length <= MAX_SEGMENT) return `preview--${slug}`;
	const hash = crypto.createHash('sha256').update(branch).digest('hex').slice(0, SLUG_HASH);
	const head = slug.slice(0, MAX_SEGMENT - SLUG_HASH - 1).replace(/-+$/, '');
	return `preview--${head}-${hash}`;
}

export function instanceId(appId: string, envTag: string = PROD_ENV): string {
	const env = normalizeEnvTag(envTag);
	return env === PROD_ENV ? appId : `${appId}--${env}`;
}

export function isProd(envTag: string): boolean {
	return normalizeEnvTag(envTag) === PROD_ENV;
}

/**
 * A release id sorts lexicographically by time, which is how the server tells
 * a late-arriving older deploy from a newer one. The suffix keeps two deploys
 * started in the same second out of one directory; a bare stamp, as older
 * CLIs wrote, sorts just before its suffixed form.
 */
export function releaseId(date = new Date(), suffix = randomSuffix()): string {
	const stamp = date
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'Z');
	return `${stamp}-${suffix}`;
}

function randomSuffix(): string {
	return crypto.randomBytes(2).toString('hex');
}
