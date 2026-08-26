import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addServerOptions, applyRestart, withServerContext } from '../../lib/server-command.ts';
import { isValidKey, readRemoteEnv, writeRemoteEnv } from '../../lib/remote-env.ts';

export const envSet = addServerOptions(
	new Command('set')
		.description('set a production variable')
		.argument('<key>', 'variable name')
		.argument('[value]', 'value — prompted for, without echo, when omitted')
		.configureHelp(helpConfig)
).action((key: string, value: string | undefined, raw: unknown) =>
	runCommand(
		() =>
			withServerContext(raw, async (ctx) => {
				if (!isValidKey(key)) {
					throw new Error(`${key} is not a valid environment variable name.`);
				}

				const resolved = value ?? (await promptValue(key));
				const env = await readRemoteEnv(ctx.session, ctx.instance);
				await writeRemoteEnv(ctx.session, ctx.instance, { ...env, [key]: resolved });

				p.log.success(`${key} updated`);
				await applyRestart(ctx);
			}),
		'Failed to set the variable.'
	)
);

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
