import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import * as p from '@clack/prompts';
import { x } from 'tinyexec';
import { DATA_DIR, MIGRATIONS_DIR } from './constants.ts';
import { isInteractive } from './providers.ts';
import { findWorkspaceRoot } from './workspace.ts';

/**
 * Where `data/` and `migrations/` are: the project root, not the directory the
 * command happened to be run from. From `src/routes` the cwd would have
 * PocketBase create an empty database there and report nothing to migrate.
 */
export function migrateRoot(): string {
	return findWorkspaceRoot() ?? process.cwd();
}

async function pocketbaseMigrateArgs(cwd: string, args: string[]): Promise<[string, string[]]> {
	const { pocketbaseBinaryPath } = await import('./pocketbase.ts');
	return [
		pocketbaseBinaryPath(),
		[
			'--dir',
			path.join(cwd, DATA_DIR),
			'--migrationsDir',
			path.join(cwd, MIGRATIONS_DIR),
			'migrate',
			...args
		]
	];
}

export async function runPocketbaseMigrate(args: string[]): Promise<void> {
	const cwd = migrateRoot();
	const [binaryPath, binaryArgs] = await pocketbaseMigrateArgs(cwd, args);

	await x(binaryPath, binaryArgs, {
		nodeOptions: { cwd, stdio: 'inherit' },
		throwOnError: true
	});
}

/**
 * Run a `migrate` subcommand that asks `(y/N)` on stdin, answering yes.
 *
 * PocketBase has no `--yes`, and it exits 0 whether the answer was yes, no or
 * a closed stdin, so the caller confirms first and then reads the output to
 * learn what happened. Nothing is passed through: the prompt (on stderr) has
 * already been answered, and stdout is returned without colour codes.
 */
export async function runPocketbaseMigrateConfirmed(args: string[]): Promise<string> {
	const cwd = migrateRoot();
	const [binaryPath, binaryArgs] = await pocketbaseMigrateArgs(cwd, args);

	return new Promise((resolve, reject) => {
		const child = spawn(binaryPath, binaryArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) return resolve(stripAnsi(stdout));
			const detail = stripAnsi(`${stderr}\n${stdout}`).trim();
			reject(new Error(detail || `PocketBase exited with code ${code}.`));
		});
		child.stdin.on('error', () => {});
		child.stdin.end('y\n');
	});
}

function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Ask before a migrate command that PocketBase itself would have asked about.
 * `--yes` skips the question; off a terminal there is nobody to ask, so the
 * command is refused rather than run or silently skipped. Returns false when
 * the user said no.
 */
export async function confirmMigrate(
	message: string,
	{ yes, command }: { yes?: boolean; command: string }
): Promise<boolean> {
	if (yes) return true;
	if (!isInteractive() || !process.stdin.isTTY) {
		throw new Error(
			`\`${command}\` asks for confirmation. Pass --yes to run it without a terminal.`
		);
	}
	const answer = await p.confirm({ message, initialValue: false });
	return !p.isCancel(answer) && answer;
}

/** The `.js`/`.ts` files in the project's `migrations/` (none when it doesn't exist). */
export function listMigrationFiles(cwd: string): Set<string> {
	const dir = path.join(cwd, MIGRATIONS_DIR);
	if (!fs.existsSync(dir)) return new Set();
	return new Set(fs.readdirSync(dir).filter((f) => /\.[jt]s$/.test(f)));
}

/**
 * PocketBase's blank JS migration (`plugins/migratecmd/templates.go`), written
 * by vela itself: `migrate create` asks on stdin and has no `--yes`.
 */
export const BLANK_MIGRATION = `/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  // add up queries...
}, (app) => {
  // add down queries...
})
`;

/**
 * A migration name as the file will carry it: snake_case, as PocketBase's own
 * `migrate create` writes it. Throws on a name with nothing usable in it or
 * with characters that have no place in a file name.
 */
export function migrationSlug(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error('The migration name must not be empty.');
	if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(trimmed)) {
		throw new Error(
			`"${name}" is not a valid migration name. Use letters, numbers and underscores, e.g. add_post_slug.`
		);
	}
	return trimmed
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/[ _-]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toLowerCase();
}

/**
 * Write a blank migration into `migrations/` and return its file name:
 * `<unix timestamp>_<name>.js`, the name PocketBase orders migrations by.
 */
export function writeBlankMigration(cwd: string, name: string, now: Date = new Date()): string {
	const slug = migrationSlug(name);
	const dir = path.join(cwd, MIGRATIONS_DIR);
	const file = `${Math.floor(now.getTime() / 1000)}_${slug}.js`;
	const filePath = path.join(dir, file);
	if (fs.existsSync(filePath)) {
		throw new Error(`${path.join(MIGRATIONS_DIR, file)} already exists.`);
	}
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, BLANK_MIGRATION);
	return file;
}

/**
 * Run the project's own prettier over files vela just wrote, so they pass the
 * project's `prettier --check`. Best effort: a project without prettier, or a
 * prettier that fails, leaves the files as written.
 */
export async function formatWithProjectPrettier(cwd: string, files: string[]): Promise<void> {
	const bin = path.join(cwd, 'node_modules', '.bin', 'prettier');
	if (files.length === 0 || !fs.existsSync(bin)) return;
	try {
		await x(bin, ['--write', '--ignore-unknown', ...files], {
			nodeOptions: { cwd, stdio: 'ignore' }
		});
	} catch {
		// left as written
	}
}

export type MigrateDownOutcome =
	{ status: 'reverted'; files: string[] } | { status: 'none' } | { status: 'cancelled' };

/** What `pocketbase migrate down` did, read from what it printed (it exits 0 either way). */
export function parseMigrateDownOutput(stdout: string): MigrateDownOutcome {
	const files = [...stdout.matchAll(/^Reverted (.+)$/gm)].map((match) => match[1].trim());
	if (files.length > 0) return { status: 'reverted', files };
	if (/No migrations to revert/.test(stdout)) return { status: 'none' };
	return { status: 'cancelled' };
}
