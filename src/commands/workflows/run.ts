import process from 'node:process';
import { Command, InvalidArgumentError } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addTargetOptions } from '../../lib/server-command.ts';
import { withWorkflowsTarget, type WorkflowsContext } from '../../lib/workflows-target.ts';
import { createRun, settleRun, type WorkflowRun } from '../../lib/workflows-api.ts';

function parseInput(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new InvalidArgumentError('must be JSON, e.g. \'{"userId":"abc"}\'.');
	}
}

export interface RunOutcome {
	level: 'success' | 'info' | 'warn' | 'error';
	message: string;
}

type OutcomeContext = Pick<WorkflowsContext, 'remote' | 'targetName' | 'flag' | 'where'> & {
	appRunning: boolean;
};

/**
 * What to say about a run, given how far it got while it was watched.
 *
 * The engine takes a run for any name, and it is the app's worker that knows
 * which workflows exist — the app as built and running on that target, not the
 * code in this checkout. So a queued run is reported as started only once
 * something has actually claimed it.
 */
export function describeOutcome(
	run: WorkflowRun,
	ctx: OutcomeContext,
	waited: boolean
): RunOutcome {
	const name = pc.cyan(run.workflowName);
	const id = pc.bold(run.id);
	const list = pc.cyan(`vela workflows list${ctx.flag}`);
	const cancel = pc.cyan(`vela workflows cancel ${run.id}${ctx.flag}`);

	switch (run.status) {
		case 'completed':
			return { level: 'success', message: `${name} completed as run ${id}${ctx.where}.` };
		case 'failed':
			return {
				level: 'error',
				message: `Run ${id} of ${name} failed${ctx.where}.\n\n${run.error?.message ?? 'No error was recorded.'}`
			};
		case 'canceled':
			return { level: 'warn', message: `Run ${id} of ${name} was canceled${ctx.where}.` };
		case 'pending':
			break;
		default:
			return {
				level: 'success',
				message: `Started ${name} as run ${id}${ctx.where}.\n\nIt is still running; ${list} shows its state.`
			};
	}

	// A pending run carrying an error has had an attempt fail and is waiting to
	// be retried. A worker that does not know the name retries without limit.
	if (run.error) {
		const reason = run.error.message ?? 'No error was recorded.';
		const unknown = /is not registered/.test(reason);
		const advice = !unknown
			? `It will be retried; ${list} shows its state.`
			: ctx.remote
				? `The app deployed to ${ctx.targetName} does not define that workflow. Check the name, or\n` +
					`deploy the code that defines it. The run is retried until it is canceled:\n\n${cancel}`
				: `The running app does not define that workflow. The name is the one in its\n` +
					`defineWorkflow spec. The run is retried until it is canceled:\n\n${cancel}`;
		return {
			level: 'warn',
			message: `Run ${id} of ${name} was queued${ctx.where}, but its first attempt failed.\n\n${reason}\n\n${advice}`
		};
	}

	const queued = `Queued ${name} as run ${id}${ctx.where}.`;
	if (!ctx.appRunning) {
		return {
			level: 'success',
			message: `${queued}\n\nIt runs once the app is up (${pc.cyan('vela dev')}); ${list} shows its state.`
		};
	}
	if (!waited) return { level: 'success', message: `${queued}\n\n${list} shows its state.` };
	return {
		level: 'warn',
		message: ctx.remote
			? `${queued}\n\nNothing has picked it up yet. The app on ${ctx.targetName} may be stopped, busy with other runs,\n` +
				`built without any workflows, or running with WORKFLOWS_ENABLED=false.\n` +
				`${pc.cyan(`vela status${ctx.flag}`)} and ${pc.cyan(`vela logs${ctx.flag}`)} show which; ${list} shows the run.`
			: `${queued}\n\nNothing has picked it up yet. Check the output of ${pc.cyan('vela dev')} for the worker;\n${list} shows the run.`
	};
}

/**
 * Starts a run in whichever copy of the app `-t` names, and `local` unless told
 * otherwise: a run on a deployed target does whatever the workflow does, to real
 * data, so it is something asked for by name.
 */
export const workflowsRun = addTargetOptions(
	new Command('run')
		.description('start a run of a workflow; the running app picks it up')
		.argument('<name>', 'the workflow name, as in its defineWorkflow spec')
		.argument('[input]', 'the run input as JSON', parseInput)
		.option(
			'--idempotency-key <key>',
			'idempotency key — running again with the same key returns the first run instead of starting another'
		)
		.option('--no-wait', 'return once the run is queued, without watching it start')
		.configureHelp(helpConfig),
	'local'
).action((name: string, input: unknown, raw: unknown) =>
	runCommand(() => {
		const options = raw as { idempotencyKey?: string; wait: boolean };
		return withWorkflowsTarget(raw, 'workflows run', async (ctx) => {
			let run = await createRun(ctx.pb, name, input, { idempotencyKey: options.idempotencyKey });

			// Without an app beside the database there is nothing to wait for.
			const wait = options.wait && ctx.appRunning;
			if (wait) run = await settleRun(ctx.pb, run);

			const outcome = describeOutcome(run, ctx, wait);
			p.log[outcome.level](outcome.message);
			if (outcome.level === 'error') process.exitCode = 1;
		});
	}, 'Failed to start the workflow run.')
);
