import path from 'node:path';
import process from 'node:process';
import { x } from 'tinyexec';
import { DATA_DIR, MIGRATIONS_DIR } from './constants.ts';

export async function runPocketbaseMigrate(args: string[]): Promise<void> {
	const cwd = process.cwd();
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
