import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addTargetOptions } from '../../lib/server-command.ts';
import { withWorkflowsTarget } from '../../lib/workflows-target.ts';
import { cancelRun, getRun, isFinished, isHttpStatus } from '../../lib/workflows-api.ts';

export const workflowsCancel = addTargetOptions(
	new Command('cancel')
		.description('cancel a pending or running workflow run')
		.argument('<run-id>', 'the run id from `vela workflows list`')
		.option('-y, --yes', 'skip the confirmation asked for on a deployed target')
		.configureHelp(helpConfig),
	'local'
).action((id: string, raw: unknown) =>
	runCommand(() => {
		const options = raw as { yes?: boolean };
		return withWorkflowsTarget(raw, 'workflows cancel', async (ctx) => {
			// Looked up first: a run id belongs to one database, and the likeliest
			// mistake is an id from one target cancelled against another.
			const found = await getRun(ctx.pb, id);
			if (!found) {
				throw new Error(
					`${ctx.remote ? ctx.targetName : 'The local database'} has no workflow run ${pc.bold(id)}.\n\n` +
						`Each copy of the app has its own runs. ${pc.cyan(`vela workflows list${ctx.flag}`)} shows this one's` +
						(ctx.remote ? '.' : `;\npass ${pc.cyan('-t')} to cancel a run on a deployed target.`)
				);
			}

			const name = pc.cyan(found.workflowName);
			if (found.status === 'canceled') {
				p.log.info(`Run ${pc.bold(id)} of ${name} was already canceled${ctx.where}.`);
				return;
			}
			if (isFinished(found)) {
				throw new Error(
					`Run ${pc.bold(id)} of ${name} has already ${found.status === 'failed' ? 'failed' : 'completed'}, so there is nothing to cancel.`
				);
			}

			if (ctx.remote && !options.yes) {
				// Refused rather than asked where nobody can answer: a prompt with
				// no terminal reads as a "no", and exits as if that were success.
				if (!process.stdin.isTTY || process.env.CI) {
					throw new Error(
						`Cancelling a run on ${ctx.targetName} asks for confirmation, and there is no terminal to ask on.\n\n` +
							`Pass ${pc.cyan('--yes')} to cancel it without being asked.`
					);
				}
				const confirmed = await p.confirm({
					message: `Cancel the ${found.status} run ${id} of ${found.workflowName} on ${ctx.targetName}?`,
					initialValue: false
				});
				if (p.isCancel(confirmed) || !confirmed) {
					p.cancel('Operation cancelled.');
					process.exit(0);
				}
			}

			try {
				await cancelRun(ctx.pb, id);
			} catch (e) {
				// It finished between the lookup and the cancel.
				if (!isHttpStatus(e, 409)) throw e;
				throw new Error(
					`Run ${pc.bold(id)} of ${name} finished before it could be canceled.\n\n` +
						`${pc.cyan(`vela workflows list${ctx.flag}`)} shows how it ended.`
				);
			}
			p.log.success(`Canceled run ${pc.bold(id)} of ${name}${ctx.where}.`);
		});
	}, 'Failed to cancel the workflow run.')
);
