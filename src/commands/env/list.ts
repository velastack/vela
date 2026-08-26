import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addServerOptions, withServerContext } from '../../lib/server-command.ts';
import { readRemoteEnv } from '../../lib/remote-env.ts';

export const envList = addServerOptions(
	new Command('list').description('list production variable names').configureHelp(helpConfig)
).action((raw: unknown) =>
	runCommand(
		() =>
			withServerContext(raw, async (ctx) => {
				const env = await readRemoteEnv(ctx.session, ctx.instance);
				const keys = Object.keys(env).sort();
				if (keys.length === 0) {
					p.log.info('No production environment variables configured.');
					return;
				}
				// Names only, never values.
				p.log.info(
					`Production environment ${pc.dim(`(${ctx.appName}, ${ctx.envTag})`)}\n\n` +
						keys.map((key) => `  ${key}`).join('\n')
				);
			}),
		'Failed to read the environment.'
	)
);
