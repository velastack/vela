import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addTargetOptions, applyEnvRestart, withTarget } from '../../lib/server-command.ts';
import { isValidKey, readRemoteEnv, writeRemoteEnv } from '../../lib/remote-env.ts';
import { applyLocalEnvChange, setLocalEnv } from '../../lib/local-env.ts';

export const envSet = addTargetOptions(
	new Command('set')
		.description('set an environment variable')
		.argument('<key>', 'variable name')
		.argument('[value]', 'value — prompted for, without echo, when omitted')
		.configureHelp(helpConfig),
	'local'
).action((key: string, value: string | undefined, raw: unknown) =>
	runCommand(
		() =>
			withTarget(
				raw,
				{
					local: async (ctx) => {
						const resolved = await resolveValue(key, value);
						setLocalEnv(ctx.envFile, key, resolved);
						p.log.success(`${key} updated ${pc.dim('(local)')}`);
						await applyLocalEnvChange(ctx, [key]);
					},
					remote: async (ctx) => {
						const resolved = await resolveValue(key, value);
						const env = await readRemoteEnv(ctx.session, ctx.instance);
						await writeRemoteEnv(ctx.session, ctx.instance, { ...env, [key]: resolved });
						p.log.success(`${key} updated ${pc.dim(`(${ctx.targetName})`)}`);
						await applyEnvRestart(ctx, [key]);
					}
				},
				{ label: 'env set' }
			),
		'Failed to set the variable.'
	)
);

async function resolveValue(key: string, value: string | undefined): Promise<string> {
	if (!isValidKey(key)) throw new Error(`${key} is not a valid environment variable name.`);
	return value ?? (await promptValue(key));
}

async function promptValue(key: string): Promise<string> {
	const value = await p.password({
		message: `Value for ${pc.cyan(key)}`,
		validate: (input) => (!input?.length ? 'Required' : undefined)
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value;
}
