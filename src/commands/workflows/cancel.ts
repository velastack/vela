import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { cancelRun } from '../../lib/workflows-api.ts';

export const workflowsCancel = new Command('cancel')
	.description('cancel a pending or running workflow run')
	.argument('<run-id>', 'the run id from `vela workflows list`')
	.configureHelp(helpConfig)
	.action((id: string) =>
		runCommand(async () => {
			await withPocketbase(process.cwd(), async (pb) => {
				const run = await cancelRun(pb, id);
				p.log.success(`Canceled run ${pc.bold(run.id)} of ${pc.cyan(run.workflowName)}.`);
			});
		}, 'Failed to cancel the workflow run.')
	);
