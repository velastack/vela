import process from 'node:process';
import { Command, InvalidArgumentError } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { withPocketbase } from '../../lib/pocketbase.ts';
import { createRun } from '../../lib/workflows-api.ts';

function parseInput(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new InvalidArgumentError('must be JSON, e.g. \'{"userId":"abc"}\'.');
	}
}

export const workflowsRun = new Command('run')
	.description('start a run of a workflow; the running app picks it up')
	.argument('<name>', 'the workflow name, as in its defineWorkflow spec')
	.argument('[input]', 'the run input as JSON', parseInput)
	.configureHelp(helpConfig)
	.action((name: string, input: unknown) =>
		runCommand(async () => {
			await withPocketbase(process.cwd(), async (pb) => {
				const run = await createRun(pb, name, input);
				p.log.success(
					`Queued ${pc.cyan(name)} as run ${pc.bold(run.id)}.\n\n` +
						`It runs once the app is up (${pc.cyan('vela dev')}); ${pc.cyan('vela workflows list')} shows its state.`
				);
			});
		}, 'Failed to start the workflow run.')
	);
