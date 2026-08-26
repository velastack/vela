import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { addServerOptions, withServerContext } from '../lib/server-command.ts';
import { remotePaths } from '../lib/remote.ts';

export const logs = addServerOptions(
	new Command('logs')
		.description('tail the logs of a deployed app')
		.argument('[target]', 'SSH target (defaults to where this app was last deployed)')
		.configureHelp(helpConfig)
)
	.option('-f, --follow', 'keep streaming new output')
	.option('-n, --lines <count>', 'how many lines of history to show', '100')
	.option('--pocketbase', 'show the PocketBase service instead of the app')
	.action((target: string | undefined, raw: unknown) =>
		runCommand(async () => {
			const options = raw as { follow?: boolean; lines?: string; pocketbase?: boolean };
			await withServerContext(
				raw,
				async (ctx) => {
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
				},
				target
			);
		}, 'Failed to read logs.')
	);
