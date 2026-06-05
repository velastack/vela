import { Command, InvalidArgumentError } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPocketbaseMigrate } from '../../lib/migrate.ts';
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
	.configureHelp(helpConfig)
	.action((n: number) =>
		runCommand(async () => {
			await runPocketbaseMigrate(['down', String(n)]);
			reportResult({
				summary: `Reverted the last ${n} migration(s).`,
				nextSteps: [
					'Run `vela sync` to regenerate TypeScript types after the rollback.',
					'Run `vela migrate up` to reapply reverted migrations when ready.'
				]
			});
		}, 'Failed to revert migrations.')
	);
