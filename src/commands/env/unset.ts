import { Command } from 'commander';
import * as p from '@clack/prompts';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addServerOptions, applyRestart, withServerContext } from '../../lib/server-command.ts';
import { readRemoteEnv, writeRemoteEnv } from '../../lib/remote-env.ts';

export const envUnset = addServerOptions(
	new Command('unset')
		.description('remove a production variable')
		.argument('<key>', 'variable name')
		.configureHelp(helpConfig)
).action((key: string, raw: unknown) =>
	runCommand(
		() =>
			withServerContext(raw, async (ctx) => {
				const env = await readRemoteEnv(ctx.session, ctx.instance);
				if (!(key in env)) {
					p.log.info(`${key} is not set — nothing to remove.`);
					return;
				}
				delete env[key];
				await writeRemoteEnv(ctx.session, ctx.instance, env);
				p.log.success(`${key} removed`);
				await applyRestart(ctx);
			}),
		'Failed to remove the variable.'
	)
);
