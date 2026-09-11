import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { templatesDir } from './templates.ts';
import { SshSession, type RunResult } from './ssh.ts';

export const VELA_ROOT = '/var/lib/vela';
export const VELA_ETC = '/etc/vela';
/** The unprivileged account every app's files and processes belong to. */
export const VELA_USER = 'vela';
/**
 * Where each version of the server scripts lives, keyed by content hash, with
 * a `current` link for anyone reading the box by hand. Older CLIs still rsync
 * `--delete` into the sibling `/var/lib/vela/scripts`; keeping versions out of
 * that tree is what stops one of them deleting the scripts a deploy is running.
 */
export const SCRIPT_VERSIONS_DIR = `${VELA_ROOT}/script-versions`;
export const PROVISIONED_MARKER = `${VELA_ETC}/provisioned`;
/** The server's registration with velastack.dev: origin name and Worker token. */
export const ORIGIN_FILE = `${VELA_ETC}/origin.json`;

export interface ServerInfo {
	cliVersion: string;
	pocketbaseVersion: string;
	provisionedAt: string;
	layoutVersion: number;
}

export interface InstanceState {
	appId: string;
	name: string;
	env: string;
	instance: string;
	activeRelease?: string;
	previousRelease?: string;
	domain?: string;
	/** Managed velastack.app hostname(s), reached through the Worker. */
	managed?: string;
	/** The origin the app is served as. */
	url?: string;
	healthCheckPath?: string;
	pocketbaseVersion?: string;
	gitSha?: string;
	webPort?: number;
	pbPort?: number;
	backend?: boolean;
	deployedAt?: string;
	rolledBackAt?: string;
	restoredAt?: string;
	/** Backup key or uploaded filename the last restore came from. */
	restoredFrom?: string;
	/** The pb_data the last restore set aside, kept as the only undo. */
	previousDataDir?: string;
	current?: string;
	releases?: string[];
	services?: { web: string; pocketbase: string };
}

/**
 * Whether a deployed instance runs a PocketBase.
 *
 * The backend is detected from the project on every deploy and recorded in the
 * instance's state, so this is the server's answer, not the local project's -
 * the two disagree on the deploy that adds or removes one. Ports are allocated
 * in web/PocketBase pairs whether or not there is a database, so `pbPort` alone
 * proves nothing; it is only the best evidence state from before the `backend`
 * flag existed can offer.
 */
export function instanceHasBackend(state: InstanceState | undefined): boolean {
	if (!state) return false;
	return state.backend ?? Boolean(state.pbPort);
}

/** The `templates/server` tree that gets uploaded to the server. */
export function serverTemplatesDir(): string {
	return path.join(templatesDir(), 'server');
}

/** Hex digits of the content hash a script version is named by. */
const DIGEST_LENGTH = 12;

/**
 * One hash over every file in the server templates, paths included, so a
 * change to any byte of any script names a new version on the server.
 */
export function serverScriptsDigest(dir = serverTemplatesDir()): string {
	const hash = crypto.createHash('sha256');
	for (const file of listFiles(dir).sort()) {
		hash
			.update(file)
			.update('\0')
			.update(fs.readFileSync(path.join(dir, file)))
			.update('\0');
	}
	return hash.digest('hex').slice(0, DIGEST_LENGTH);
}

function listFiles(root: string, prefix = ''): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...listFiles(root, rel));
		else if (entry.isFile()) files.push(rel);
	}
	return files;
}

/** The script directory each open session was told to run from. */
const scriptDirs = new WeakMap<SshSession, string>();

/**
 * Put this CLI's copy of the server scripts on the box.
 *
 * Uploaded on every provision *and* every deploy, so the scripts a server runs
 * always match the CLI driving it — upgrading the CLI is all it takes to pick
 * up a fixed deploy script. Each version goes into its own content-hashed
 * directory and is published with one rename, so a deploy in progress keeps
 * running the scripts it started with while a newer (or older) CLI puts its
 * own alongside. A version already on the box is not uploaded again.
 */
export async function syncServerScripts(session: SshSession): Promise<string> {
	const digest = serverScriptsDigest();
	const dir = `${SCRIPT_VERSIONS_DIR}/${digest}`;
	const present = await session.script(`[ -d "$1" ] && echo yes || echo no`, { args: [dir] });
	if (present.stdout.trim() !== 'yes') {
		const incoming = `${SCRIPT_VERSIONS_DIR}/.incoming.${digest}.${process.pid}.${Date.now()}`;
		await session.script(`mkdir -p "$1" && chmod 0755 "$(dirname "$1")" "$1"`, {
			args: [incoming]
		});
		await session.uploadDir(serverTemplatesDir(), incoming, ['--chmod=D755,F755']);
		// rsync preserves the developer's uid otherwise, which leaves root-run
		// scripts owned by a uid that means nothing on the server. Then one
		// rename publishes the version; if another CLI published the same hash
		// first, theirs is identical and this upload is simply dropped.
		await session.script(
			`chown -R root:root "$1"
			if [ -d "$2" ]; then rm -rf "$1"; else mv -T "$1" "$2" || { rm -rf "$1"; [ -d "$2" ]; }; fi`,
			{ args: [incoming, dir] }
		);
	}
	// \`current\` is for people, not for the CLI: every command runs the version
	// it uploaded. Touching the directory keeps the one in use out of the
	// pruning of versions nothing has run for a month.
	await session.script(
		`touch "$1"
		ln -sfn "$1" "$2/.current.tmp" && mv -Tf "$2/.current.tmp" "$2/current"
		find "$2" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' ! -name "$(basename "$1")" -mtime +30 -exec rm -rf {} + 2>/dev/null || true
		find "$2" -mindepth 1 -maxdepth 1 -type d -name '.incoming.*' -mmin +120 -exec rm -rf {} + 2>/dev/null || true`,
		{ args: [dir, SCRIPT_VERSIONS_DIR] }
	);
	scriptDirs.set(session, dir);
	return dir;
}

/**
 * The clock the server keeps, for release ids: two machines deploying one
 * instance agree on which release is newer only if both stamp it from the
 * same clock.
 */
export async function serverTime(session: SshSession): Promise<Date> {
	const result = await session.script(`date -u +%s`);
	const seconds = Number(result.stdout.trim());
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`could not read the clock on ${session.target}`);
	}
	return new Date(seconds * 1000);
}

export interface ScriptOptions {
	args?: string[];
	stream?: boolean;
}

/**
 * Run one of the uploaded server scripts and return whatever it emitted as its
 * `VELA_RESULT` line. Progress goes to stderr, so it can stream to the user
 * while the structured result still comes back cleanly.
 */
export async function runServerScript<T = Record<string, unknown>>(
	session: SshSession,
	name: string,
	opts: ScriptOptions = {}
): Promise<T | null> {
	// `bash -s -- a b c` leaves $0 as "bash", so the script path is the first
	// positional and has to be shifted off before exec.
	const dir = scriptDirs.get(session) ?? `${SCRIPT_VERSIONS_DIR}/current`;
	const result = await session.script(`script="$1"; shift; exec "$script" "$@"`, {
		args: [`${dir}/${name}`, ...(opts.args ?? [])],
		stream: opts.stream
	});
	return parseResult<T>(result);
}

export function parseResult<T>(result: RunResult): T | null {
	const line = result.stdout
		.split('\n')
		.reverse()
		.find((l) => l.startsWith('VELA_RESULT '));
	if (!line) return null;
	try {
		return JSON.parse(line.slice('VELA_RESULT '.length)) as T;
	} catch {
		return null;
	}
}

export async function readServerInfo(session: SshSession): Promise<ServerInfo | null> {
	const raw = await session.readFile(PROVISIONED_MARKER);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as ServerInfo;
	} catch {
		return null;
	}
}

export interface ServerIdentity {
	serverId: string;
	originHost: string;
	token: string;
}

export async function readServerIdentity(session: SshSession): Promise<ServerIdentity | null> {
	const raw = await session.readFile(ORIGIN_FILE);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<ServerIdentity>;
		if (!parsed.serverId || !parsed.originHost || !parsed.token) return null;
		return { serverId: parsed.serverId, originHost: parsed.originHost, token: parsed.token };
	} catch {
		return null;
	}
}

/** Root-only: the token is what lets the origin site trust a request. */
export async function writeServerIdentity(
	session: SshSession,
	identity: ServerIdentity
): Promise<void> {
	await session.writeFile(ORIGIN_FILE, JSON.stringify(identity, null, 2) + '\n', '0600');
}

export async function requireProvisioned(session: SshSession): Promise<ServerInfo> {
	const info = await readServerInfo(session);
	if (!info) {
		throw new Error(
			`${session.target} has not been provisioned for vela yet.\n\n` +
				`Run \`vela provision ${session.target}\` first.`
		);
	}
	return info;
}

export async function readInstanceStates(
	session: SshSession,
	instance?: string
): Promise<InstanceState[]> {
	const result = await runServerScript<InstanceState[]>(session, 'status.sh', {
		args: instance ? [instance] : []
	});
	return Array.isArray(result) ? result : [];
}

/** Paths on the server, kept in one place so the scripts and CLI agree. */
export const remotePaths = {
	app: (instance: string) => `${VELA_ROOT}/apps/${instance}`,
	releases: (instance: string) => `${VELA_ROOT}/apps/${instance}/releases`,
	release: (instance: string, release: string) =>
		`${VELA_ROOT}/apps/${instance}/releases/${release}`,
	shared: (instance: string) => `${VELA_ROOT}/apps/${instance}/shared`,
	pbData: (instance: string) => `${VELA_ROOT}/apps/${instance}/shared/pb_data`,
	storage: (instance: string) => `${VELA_ROOT}/apps/${instance}/shared/pb_data/storage`,
	backups: (instance: string) => `${VELA_ROOT}/apps/${instance}/shared/pb_data/backups`,
	backup: (instance: string, key: string) =>
		`${VELA_ROOT}/apps/${instance}/shared/pb_data/backups/${key}`,
	/** Where an archive uploaded from this machine waits, outside pb_data. */
	restoreStage: (instance: string) => `${VELA_ROOT}/apps/${instance}/shared/.restore`,
	env: (instance: string) => `${VELA_ETC}/apps/${instance}/env`,
	runtimeEnv: (instance: string) => `${VELA_ETC}/apps/${instance}/runtime.env`,
	caddy: (instance: string) => `${VELA_ETC}/caddy/${instance}.caddy`,
	route: (instance: string) => `${VELA_ETC}/caddy/routes/${instance}.route`,
	webUnit: (instance: string) => `vela-web@${instance}.service`,
	pbUnit: (instance: string) => `vela-pb@${instance}.service`
};
