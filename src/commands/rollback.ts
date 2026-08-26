import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { addServerOptions, withServerContext } from '../lib/server-command.ts';
import { runServerScript } from '../lib/remote.ts';

export const rollback = addServerOptions(
	new Command('rollback')
		.description('put the previous release back')
		.argument('[target]', 'SSH target (defaults to where this app was last deployed)')
		.configureHelp(helpConfig)
)
	.option('--to <release>', 'roll back to a specific release instead of the previous one')
	.action((target: string | undefined, raw: unknown) =>
		runCommand(async () => {
			const options = raw as { to?: string };
			await withServerContext(
				raw,
				async (ctx) => {
					p.log.step(`Rolling back ${pc.cyan(ctx.appName)} on ${ctx.target}`);

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
				},
				target
			);
		}, 'Failed to roll back.')
	);
