import fs from 'node:fs';
import dotenv from 'dotenv';
import { remotePaths } from './remote.ts';
import type { SshSession } from './ssh.ts';

export type EnvRecord = Record<string, string>;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidKey(key: string): boolean {
	return KEY_PATTERN.test(key);
}

/**
 * Parse a vela-managed env file.
 *
 * The file is read by systemd, not by dotenv, so quoting follows systemd's
 * `EnvironmentFile` rules: values are double-quoted and `\\`, `\"` and `\n` are
 * the escapes. vela writes every value that way, and this reads it back.
 */
export function parseEnv(content: string): EnvRecord {
	const result: EnvRecord = {};
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq < 1) continue;
		const key = trimmed.slice(0, eq).trim();
		if (!isValidKey(key)) continue;
		result[key] = unquote(trimmed.slice(eq + 1).trim());
	}
	return result;
}

function unquote(raw: string): string {
	if (!raw.startsWith('"')) return raw;
	const body = raw.endsWith('"') && raw.length > 1 ? raw.slice(1, -1) : raw.slice(1);
	let out = '';
	for (let i = 0; i < body.length; i++) {
		if (body[i] !== '\\' || i === body.length - 1) {
			out += body[i];
			continue;
		}
		const next = body[++i];
		if (next === 'n') out += '\n';
		else if (next === 't') out += '\t';
		else out += next;
	}
	return out;
}

/** Canonical, deterministic serialization: sorted keys, always quoted. */
export function serializeEnv(env: EnvRecord): string {
	const keys = Object.keys(env).sort();
	const lines = [
		'# Managed by `vela env`. Values are read by systemd at service start.',
		...keys.map((key) => `${key}=${quote(env[key]!)}`)
	];
	return lines.join('\n') + '\n';
}

function quote(value: string): string {
	const escaped = value
		.replaceAll('\\', '\\\\')
		.replaceAll('"', '\\"')
		.replaceAll('\n', '\\n')
		.replaceAll('\t', '\\t');
	return `"${escaped}"`;
}

/** Read a local dotenv file, using dotenv's parser for whatever the user wrote. */
export function readLocalEnvFile(file: string): EnvRecord {
	const parsed = dotenv.parse(fs.readFileSync(file));
	const result: EnvRecord = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (isValidKey(key)) result[key] = value;
	}
	return result;
}

export async function readRemoteEnv(session: SshSession, instance: string): Promise<EnvRecord> {
	const content = await session.readFile(remotePaths.env(instance));
	return content ? parseEnv(content) : {};
}

/**
 * Replace the instance's env file. The contents travel inside the piped script
 * as base64, so no secret is ever an argument to a remote command.
 */
export async function writeRemoteEnv(
	session: SshSession,
	instance: string,
	env: EnvRecord
): Promise<void> {
	const file = remotePaths.env(instance);
	await session.writeFile(file, serializeEnv(env), '0600');
	await session.script(`chown root:root "$1" && chmod 0600 "$1"`, { args: [file] });
}

export interface RestartOutcome {
	deployed: boolean;
	restarted: boolean;
	error?: string;
}

/**
 * Restart an instance so new values take effect. An env change that lands but
 * fails to restart is reported as exactly that — the value is stored either way,
 * so it is never rolled back over a restart failure.
 */
export async function restartInstance(
	session: SshSession,
	instance: string
): Promise<RestartOutcome> {
	// Only units this instance actually enabled — a frontend-only app has no
	// PocketBase service, and restarting a unit that was never deployed fails.
	const result = await session.script(
		`instance="$1"
enabled=()
for unit in "vela-pb@$instance.service" "vela-web@$instance.service"; do
	if systemctl is-enabled "$unit" >/dev/null 2>&1; then enabled+=("$unit"); fi
done
if [ \${#enabled[@]} -eq 0 ]; then echo NOT_DEPLOYED; exit 0; fi
systemctl restart "\${enabled[@]}"`,
		{ args: [instance], check: false }
	);

	if (result.stdout.includes('NOT_DEPLOYED')) return { deployed: false, restarted: false };
	if (result.exitCode !== 0) {
		return { deployed: true, restarted: false, error: result.stderr.trim() };
	}
	return { deployed: true, restarted: true };
}
