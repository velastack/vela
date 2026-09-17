import process from 'node:process';
import { Command, InvalidArgumentError } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { listRuns, type RunStatus, type WorkflowRun } from '../../lib/workflows-api.ts';

const STATUSES: RunStatus[] = ['pending', 'running', 'completed', 'failed', 'canceled'];

function parseStatus(value: string): RunStatus {
	if (!STATUSES.includes(value as RunStatus)) {
		throw new InvalidArgumentError(`must be one of: ${STATUSES.join(', ')}`);
	}
	return value as RunStatus;
}

function parseLimit(value: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1 || n > 500) {
		throw new InvalidArgumentError('must be a whole number between 1 and 500.');
	}
	return n;
}

const STATUS_COLOR: Record<RunStatus, (s: string) => string> = {
	pending: pc.yellow,
	running: pc.cyan,
	completed: pc.green,
	failed: pc.red,
	canceled: pc.dim
};

export function formatRun(run: WorkflowRun, nameWidth: number): string {
	const status = STATUS_COLOR[run.status](run.status.padEnd(9));
	const when = pc.dim((run.finishedAt ?? run.updatedAt).replace('T', ' ').slice(0, 19));
	const attempts = run.attempts > 1 ? pc.dim(` ×${run.attempts}`) : '';
	const error =
		run.status === 'failed' && run.error?.message ? pc.red(`  ${run.error.message}`) : '';
	return `${run.id}  ${run.workflowName.padEnd(nameWidth)}  ${status}${attempts}  ${when}${error}`;
}

export const workflowsList = new Command('list')
	.description('list recent workflow runs')
	.option('--status <status>', `only runs in this state (${STATUSES.join(', ')})`, parseStatus)
	.option('--name <workflow>', 'only runs of this workflow')
	.option('--limit <n>', 'how many to show', parseLimit, 50)
	.configureHelp(helpConfig)
	.action((options: { status?: RunStatus; name?: string; limit: number }) =>
		runCommand(async () => {
			await withPocketbase(process.cwd(), async (pb) => {
				const runs = await listRuns(pb, {
					status: options.status,
					workflowName: options.name,
					limit: options.limit
				});
				if (runs.length === 0) {
					p.log.info(
						'No workflow runs yet.\n\n' +
							`Start one from server code with ${pc.cyan('<workflow>.run(input)')}, or with ${pc.cyan('vela workflows run <name>')}.`
					);
					return;
				}
				const width = Math.max(...runs.map((r) => r.workflowName.length));
				p.log.message(runs.map((r) => formatRun(r, width)).join('\n'));
			});
		}, 'Failed to list workflow runs.')
	);
