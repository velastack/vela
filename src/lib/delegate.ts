import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

/**
 * The CLI is normally installed globally, but a project pins its own copy as a
 * dev dependency so that generated source, migrations, and builds are
 * reproducible across machines and CI. When a global `vela` is invoked inside a
 * project that pins a different version, hand off to the pinned one — otherwise
 * the same command produces different output depending on who ran it.
 *
 * `create` and `bless` are exempt: they bootstrap or convert a project, so they
 * should use the version the user actually invoked rather than inherit the pin
 * of whatever project happens to be above the working directory.
 */
const NO_DELEGATE_COMMANDS = new Set(['create', 'bless']);

/** Set on the delegated child so it can never hand off again. */
export const NO_DELEGATE_ENV = 'VELA_NO_DELEGATE';

export interface LocalCli {
	binPath: string;
	version: string;
}

function realpath(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

/**
 * Find a project-local `vela` at or above `cwd` that differs from the running
 * one. Returns null when there is nothing to hand off to: no local install, the
 * local install *is* the running one, or the two are the same version.
 */
export function findLocalCli(cwd: string, selfPath: string): LocalCli | null {
	const self = realpath(selfPath);
	let dir = path.resolve(cwd);

	for (;;) {
		const pkgPath = path.join(dir, 'node_modules', 'vela', 'package.json');
		if (fs.existsSync(pkgPath)) {
			const local = readLocalCli(pkgPath);
			if (local && realpath(local.binPath) !== self) return local;
			return null;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function readLocalCli(pkgPath: string): LocalCli | null {
	let pkg: { version?: unknown; bin?: unknown };
	try {
		pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	} catch {
		return null;
	}

	const version = typeof pkg.version === 'string' ? pkg.version : null;
	const bin = pkg.bin;
	const rel = typeof bin === 'string' ? bin : isRecord(bin) ? bin.vela : undefined;
	if (!version || typeof rel !== 'string') return null;

	const binPath = path.resolve(path.dirname(pkgPath), rel);
	if (!fs.existsSync(binPath)) return null;
	return { binPath, version };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** True when `argv` names a command that must not be handed off. */
export function isDelegatable(argv: string[]): boolean {
	const first = argv.find((arg) => !arg.startsWith('-'));
	return first === undefined || !NO_DELEGATE_COMMANDS.has(first);
}

export interface DelegateOptions {
	argv?: string[];
	cwd?: string;
	selfPath: string;
	selfVersion: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Hand off to a project-local CLI when one is pinned at a different version.
 * Returns the child's exit code, or null when the running CLI should handle the
 * command itself.
 */
export function delegateToLocalCli(opts: DelegateOptions): number | null {
	const env = opts.env ?? process.env;
	if (env[NO_DELEGATE_ENV]) return null;

	const argv = opts.argv ?? process.argv.slice(2);
	if (!isDelegatable(argv)) return null;

	const local = findLocalCli(opts.cwd ?? process.cwd(), opts.selfPath);
	if (!local || local.version === opts.selfVersion) return null;

	const result = spawnSync(process.execPath, [local.binPath, ...argv], {
		stdio: 'inherit',
		env: { ...env, [NO_DELEGATE_ENV]: '1' }
	});

	if (result.error) return null;
	if (result.signal) return 1;
	return result.status ?? 0;
}
