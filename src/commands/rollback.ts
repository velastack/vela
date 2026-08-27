import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { addTargetOptions, withTarget } from '../lib/server-command.ts';
import { runServerScript } from '../lib/remote.ts';

export const rollback = addTargetOptions(
	new Command('rollback').description('put the previous release back').configureHelp(helpConfig),
	'production'
)
	.option('--to <release>', 'roll back to a specific release instead of the previous one')
	.action((raw: unknown) =>
		runCommand(async () => {
			const options = raw as { to?: string };
			await withTarget(
				raw,
				{
					remote: async (ctx) => {
						p.log.step(
							`Rolling back ${pc.cyan(ctx.appName)} ${pc.dim(`(${ctx.targetName})`)} on ${ctx.server}`
						);

						const result = await runServerScript<{ release: string; from: string }>(
							ctx.session,
							'rollback.sh',
							{
								args: [ctx.instance, ...(options.to ? ['--to', options.to] : [])],
								stream: true
							}
						);

						p.log.success(
							`Rolled back to ${pc.cyan(result?.release ?? 'the previous release')}` +
								(result?.from ? ` ${pc.dim(`(was ${result.from})`)}` : '')
						);
					}
				},
				{
					label: 'rollback',
					localHint: 'Nothing is released locally — `vela dev` always runs the working tree.'
				}
			);
		}, 'Failed to roll back.')
	);
