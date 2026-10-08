import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { applyLocalEnvChange, readLocalEnv, unsetLocalEnv } from '../../lib/local-env.ts';
import { addEnvTargetOptions, applyChange, withEnvScope } from '../../lib/env-command.ts';
import { unsetInLayer } from '../../lib/env-scopes.ts';

export const envUnset = addEnvTargetOptions(
	new Command('unset')
		.description('remove an environment variable')
		.argument('<key>', 'variable name')
		.configureHelp(helpConfig)
).action((key: string, raw: unknown) =>
	runCommand(
		() =>
			withEnvScope(
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
					// Removed from whichever side it was on; nobody should have to
					// remember whether a key was public to take it out.
					instance: async (ctx) => {
						if (!(await unsetInLayer(ctx.session, ctx.files, key))) {
							p.log.info(`${key} is not set on ${ctx.targetName} — nothing to remove.`);
							return;
						}
						p.log.success(`${key} removed ${pc.dim(`(${ctx.targetName})`)}`);
						await applyChange(ctx.workspaceRootDir, ctx, [key]);
					},
					layer: async (ctx) => {
						if (!(await unsetInLayer(ctx.session, ctx.files, key))) {
							p.log.info(`${key} is not set (${ctx.layer}, ${ctx.server}) — nothing to remove.`);
							return;
						}
						p.log.success(`${key} removed ${pc.dim(`(${ctx.layer}, ${ctx.server})`)}`);
						await applyChange(ctx.workspaceRootDir, ctx, [key]);
					}
				},
				{ label: 'env unset', ask: true }
			),
		'Failed to remove the variable.'
	)
);
