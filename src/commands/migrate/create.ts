import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPocketbaseMigrate } from '../../lib/migrate.ts';
import { MIGRATIONS_DIR } from '../../lib/constants.ts';
import { reportResult } from '../../lib/result-report.ts';

export const create = new Command('create')
	.alias('new')
	.description('create a new blank migration')
	.argument('<name>', 'migration name (snake_case)')
	.configureHelp(helpConfig)
	.action((name: string) =>
		runCommand(async () => {
			const cwd = process.cwd();
			const before = listMigrationFiles(cwd);
			await runPocketbaseMigrate(['create', name]);
			const after = listMigrationFiles(cwd);
			const added = [...after].filter((f) => !before.has(f));

			reportResult({
				summary: `Created blank migration ${name}.`,
				filesCreated: added.map((f: string) => path.join(MIGRATIONS_DIR, f)),
				nextSteps: [
					`Open the new file in ${MIGRATIONS_DIR}/ and fill in the up/down handlers.`,
					'Run `vela migrate up` to apply the migration once the handlers are written.'
				]
			});
		}, 'Failed to create migration.')
	);

function listMigrationFiles(cwd: string): Set<string> {
	const dir = path.join(cwd, MIGRATIONS_DIR);
	if (!fs.existsSync(dir)) return new Set();
	return new Set(fs.readdirSync(dir).filter((f) => /\.[jt]s$/.test(f)));
}
