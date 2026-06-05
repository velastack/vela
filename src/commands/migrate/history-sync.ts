import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPocketbaseMigrate } from '../../lib/migrate.ts';
import { reportResult } from '../../lib/result-report.ts';

export const historySync = new Command('history-sync')
	.description('drop _migrations rows whose files no longer exist')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			await runPocketbaseMigrate(['history-sync']);
			reportResult({
				summary: 'Synced migration history with files on disk.',
				nextSteps: ['Run `vela migrate up` if any pending migrations surfaced after the sync.']
			});
		}, 'Failed to sync migration history.')
	);
