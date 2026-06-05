import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPocketbaseMigrate } from '../../lib/migrate.ts';
import { MIGRATIONS_DIR } from '../../lib/constants.ts';
import { reportResult } from '../../lib/result-report.ts';

export const collections = new Command('collections')
	.alias('snapshot')
	.description('snapshot local collections into a new migration')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const cwd = process.cwd();
			const before = listMigrationFiles(cwd);
			await runPocketbaseMigrate(['collections']);
			const after = listMigrationFiles(cwd);
			const added = [...after].filter((f) => !before.has(f));

			if (added.length === 0) {
				reportResult({
					summary: 'No schema changes to snapshot — migrations are already up to date.'
				});
				return;
			}

			reportResult({
				summary: 'Snapshotted local collections into a new migration.',
				filesCreated: added.map((f: string) => path.join(MIGRATIONS_DIR, f)),
				nextSteps: [
					`Review the generated snapshot in ${MIGRATIONS_DIR}/.`,
					'Commit the snapshot so teammates pick up the new schema.',
					'Run `vela migrate up` on other environments to apply the schema.'
				]
			});
		}, 'Failed to snapshot collections.')
	);

function listMigrationFiles(cwd: string): Set<string> {
	const dir = path.join(cwd, MIGRATIONS_DIR);
	if (!fs.existsSync(dir)) return new Set();
	return new Set(fs.readdirSync(dir).filter((f) => /\.[jt]s$/.test(f)));
}
