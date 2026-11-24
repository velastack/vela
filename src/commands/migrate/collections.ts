import path from 'node:path';
import * as p from '@clack/prompts';
import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import {
	confirmMigrate,
	formatWithProjectPrettier,
	listMigrationFiles,
	migrateRoot,
	runPocketbaseMigrateConfirmed
} from '../../lib/migrate.ts';
import { MIGRATIONS_DIR } from '../../lib/constants.ts';
import { reportResult } from '../../lib/result-report.ts';

export const collections = new Command('collections')
	.alias('snapshot')
	.description('snapshot local collections into a new migration')
	.option('-y, --yes', 'skip the confirmation prompt')
	.configureHelp(helpConfig)
	.action((options: { yes?: boolean }) =>
		runCommand(async () => {
			const cwd = migrateRoot();
			const confirmed = await confirmMigrate(
				'Snapshot every local collection into a new migration?',
				{ yes: options.yes, command: 'vela migrate collections' }
			);
			if (!confirmed) {
				p.cancel('Operation cancelled.');
				return;
			}

			const before = listMigrationFiles(cwd);
			const output = await runPocketbaseMigrateConfirmed(['collections']);
			const after = listMigrationFiles(cwd);
			const added = [...after]
				.filter((f) => !before.has(f))
				.map((f) => path.join(MIGRATIONS_DIR, f));

			// PocketBase exits 0 whether or not it wrote the file, so the file is
			// the only proof.
			if (added.length === 0) {
				const detail = output.trim();
				throw new Error(
					`PocketBase did not write a snapshot to ${MIGRATIONS_DIR}/.${detail ? `\n\n${detail}` : ''}`
				);
			}
			await formatWithProjectPrettier(cwd, added);

			reportResult({
				summary: 'Snapshotted local collections into a new migration.',
				filesCreated: added,
				nextSteps: [
					`Review the generated snapshot in ${MIGRATIONS_DIR}/.`,
					'Commit the snapshot so teammates pick up the new schema.',
					'Run `vela migrate up` on other environments to apply the schema.'
				]
			});
		}, 'Failed to snapshot collections.')
	);
