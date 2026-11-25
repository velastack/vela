import * as p from '@clack/prompts';
import { Command, InvalidArgumentError } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import {
	confirmMigrate,
	parseMigrateDownOutput,
	runPocketbaseMigrateConfirmed
} from '../../lib/migrate.ts';
import { reportResult } from '../../lib/result-report.ts';

export function parseSteps(value: string): number {
	const n = parseInt(value, 10);
	if (!Number.isFinite(n) || n <= 0) {
		throw new InvalidArgumentError('number must be a positive integer');
	}
	return n;
}

export const down = new Command('down')
	.alias('rollback')
	.description('revert the last N applied migrations')
	.argument('[number]', 'how many migrations to revert', parseSteps, 1)
	.option('-y, --yes', 'skip the confirmation prompt')
	.configureHelp(helpConfig)
	.action((n: number, options: { yes?: boolean }) =>
		runCommand(async () => {
			const confirmed = await confirmMigrate(
				n === 1 ? 'Revert the last applied migration?' : `Revert the last ${n} applied migrations?`,
				{ yes: options.yes, command: 'vela migrate down' }
			);
			if (!confirmed) {
				p.cancel('Operation cancelled.');
				return;
			}

			// PocketBase exits 0 for reverted, nothing to revert and cancelled
			// alike; what it printed says which.
			const output = await runPocketbaseMigrateConfirmed(['down', String(n)]);
			const outcome = parseMigrateDownOutput(output);

			if (outcome.status === 'cancelled') {
				const detail = output.trim();
				throw new Error(`PocketBase reverted nothing.${detail ? `\n\n${detail}` : ''}`);
			}
			if (outcome.status === 'none') {
				reportResult({ summary: 'No migrations to revert.' });
				return;
			}

			reportResult({
				summary: `Reverted ${outcome.files.length} migration(s).`,
				sections: [{ label: 'Migrations reverted', items: outcome.files }],
				nextSteps: [
					'Run `vela sync` to regenerate TypeScript types after the rollback.',
					'Run `vela migrate up` to reapply reverted migrations when ready.'
				]
			});
		}, 'Failed to revert migrations.')
	);
