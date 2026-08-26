import path from 'node:path';
import { templatesDir } from './templates.ts';
import { SshSession, type RunResult } from './ssh.ts';

export const VELA_ROOT = '/var/lib/vela';
export const VELA_ETC = '/etc/vela';
export const SCRIPTS_DIR = `${VELA_ROOT}/scripts`;
export const PROVISIONED_MARKER = `${VELA_ETC}/provisioned`;

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
	healthCheckPath?: string;
	pocketbaseVersion?: string;
	gitSha?: string;
	webPort?: number;
	pbPort?: number;
	backend?: boolean;
	deployedAt?: string;
	rolledBackAt?: string;
	current?: string;
	releases?: string[];
	services?: { web: string; pocketbase: string };
}

/** The `templates/server` tree that gets uploaded to `/var/lib/vela/scripts`. */
export function serverTemplatesDir(): string {
	return path.join(templatesDir(), 'server');
}

/**
 * Put this CLI's copy of the server scripts on the box.
 *
 * Uploaded on every provision *and* every deploy, so the scripts a server runs
 * always match the CLI driving it — upgrading the CLI is all it takes to pick
 * up a fixed deploy script.
 */
export async function syncServerScripts(session: SshSession): Promise<void> {
	await session.script(`mkdir -p "$1" && chmod 0755 "$1"`, { args: [SCRIPTS_DIR] });
	await session.uploadDir(serverTemplatesDir(), SCRIPTS_DIR, ['--chmod=D755,F755']);
	// rsync preserves the developer's uid otherwise, which leaves root-run
	// scripts owned by a uid that means nothing on the server.
	await session.script(`chown -R root:root "$1"`, { args: [SCRIPTS_DIR] });
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
	const result = await session.script(`script="$1"; shift; exec "$script" "$@"`, {
		args: [`${SCRIPTS_DIR}/${name}`, ...(opts.args ?? [])],
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
	env: (instance: string) => `${VELA_ETC}/apps/${instance}/env`,
	runtimeEnv: (instance: string) => `${VELA_ETC}/apps/${instance}/runtime.env`,
	caddy: (instance: string) => `${VELA_ETC}/caddy/${instance}.caddy`,
	webUnit: (instance: string) => `vela-web@${instance}.service`,
	pbUnit: (instance: string) => `vela-pb@${instance}.service`
};
