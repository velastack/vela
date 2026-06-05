import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPocketbaseMigrate } from '../../lib/migrate.ts';
import { reportResult } from '../../lib/result-report.ts';

export async function runMigrateUp(): Promise<void> {
	await runPocketbaseMigrate(['up']);
	reportResult({
		summary: 'Ran pending migrations.',
		nextSteps: [
			'Run `vela sync` to refresh generated TypeScript types from the updated schema.',
			'Run `vela dev` to pick up the new schema in the running app.',
			'Run `vela migrate down` if you need to revert the last migration.'
		]
	});
}

export const up = new Command('up')
	.description('apply all pending migrations')
	.configureHelp(helpConfig)
	.action(() => runCommand(runMigrateUp, 'Failed to run migrations.'));
