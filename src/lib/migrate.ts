import path from 'node:path';
import process from 'node:process';
import { x } from 'tinyexec';
import { DATA_DIR, MIGRATIONS_DIR } from './constants.ts';
import { findWorkspaceRoot } from './workspace.ts';

/**
 * Where `data/` and `migrations/` are: the project root, not the directory the
 * command happened to be run from. From `src/routes` the cwd would have
 * PocketBase create an empty database there and report nothing to migrate.
 */
export function migrateRoot(): string {
	return findWorkspaceRoot() ?? process.cwd();
}

export async function runPocketbaseMigrate(args: string[]): Promise<void> {
	const cwd = migrateRoot();
	const { getBinaryPath } = await import('pocketbase-server');
	const binaryPath = getBinaryPath();

	await x(
		binaryPath,
		[
			'--dir',
			path.join(cwd, DATA_DIR),
			'--migrationsDir',
			path.join(cwd, MIGRATIONS_DIR),
			'migrate',
			...args
		],
		{
			nodeOptions: { cwd, stdio: 'inherit' },
			throwOnError: true
		}
	);
}
