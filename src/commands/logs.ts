import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { addTargetOptions, withTarget } from '../lib/server-command.ts';
import { remotePaths } from '../lib/remote.ts';

export const logs = addTargetOptions(
	new Command('logs').description('tail the logs of a deployed app').configureHelp(helpConfig),
	'production'
)
	.option('-f, --follow', 'keep streaming new output')
	.option('-n, --lines <count>', 'how many lines of history to show', '100')
	.option('--pocketbase', 'show the PocketBase service instead of the app')
	.action((raw: unknown) =>
		runCommand(async () => {
			const options = raw as { follow?: boolean; lines?: string; pocketbase?: boolean };
			await withTarget(
				raw,
				{
					remote: async (ctx) => {
						const unit = options.pocketbase
							? remotePaths.pbUnit(ctx.instance)
							: remotePaths.webUnit(ctx.instance);
						const command = [
							'journalctl',
							'-u',
							unit,
							'-n',
							options.lines ?? '100',
							'--no-pager',
							...(options.follow ? ['-f'] : [])
						];
						const code = await ctx.session.interactive(command);
						if (code !== 0 && !options.follow) {
							throw new Error(`journalctl exited ${code}.`);
						}
					}
				},
				{
					label: 'logs',
					localHint:
						'There are no logs for the copy on this machine — `vela dev` prints them as it runs.'
				}
			);
		}, 'Failed to read logs.')
	);
