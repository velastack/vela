import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addTargetOptions, applyEnvRestart, withTarget } from '../../lib/server-command.ts';
import { readRemoteEnv, writeRemoteEnv } from '../../lib/remote-env.ts';
import { applyLocalEnvChange, readLocalEnv, unsetLocalEnv } from '../../lib/local-env.ts';

export const envUnset = addTargetOptions(
	new Command('unset')
		.description('remove an environment variable')
		.argument('<key>', 'variable name')
		.configureHelp(helpConfig),
	'local'
).action((key: string, raw: unknown) =>
	runCommand(
		() =>
			withTarget(
				raw,
				{
					local: async (ctx) => {
						if (!(key in readLocalEnv(ctx.envFile))) {
							p.log.info(`${key} is not set — nothing to remove.`);
							return;
						}
						unsetLocalEnv(ctx.envFile, key);
						p.log.success(`${key} removed ${pc.dim('(local)')}`);
						await applyLocalEnvChange(ctx, [key]);
					},
					remote: async (ctx) => {
						const env = await readRemoteEnv(ctx.session, ctx.instance);
						if (!(key in env)) {
							p.log.info(`${key} is not set — nothing to remove.`);
							return;
						}
						delete env[key];
						await writeRemoteEnv(ctx.session, ctx.instance, env);
						p.log.success(`${key} removed ${pc.dim(`(${ctx.targetName})`)}`);
						await applyEnvRestart(ctx, [key]);
					}
				},
				{ label: 'env unset' }
			),
		'Failed to remove the variable.'
	)
);
