import path from 'node:path';
import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { formatWithProjectPrettier, migrateRoot, writeBlankMigration } from '../../lib/migrate.ts';
import { MIGRATIONS_DIR } from '../../lib/constants.ts';
import { reportResult } from '../../lib/result-report.ts';

export const create = new Command('create')
	.alias('new')
	.description('create a new blank migration')
	.argument('<name>', 'migration name (snake_case)')
	.configureHelp(helpConfig)
	.action((name: string) =>
		runCommand(async () => {
			const cwd = migrateRoot();
			// Written here rather than by `pocketbase migrate create`, which asks
			// (y/N) on stdin and exits 0 without writing when nobody answers.
			const file = path.join(MIGRATIONS_DIR, writeBlankMigration(cwd, name));
			await formatWithProjectPrettier(cwd, [file]);

			reportResult({
				summary: `Created blank migration ${file}.`,
				filesCreated: [file],
				nextSteps: [
					`Open ${file} and fill in the up and down handlers.`,
					'Run `vela migrate up` to apply the migration once the handlers are written.'
				]
			});
		}, 'Failed to create migration.')
	);
