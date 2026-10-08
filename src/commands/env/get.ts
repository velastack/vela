import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { readLocalEnv } from '../../lib/local-env.ts';
import { addEnvTargetOptions, withEnvScope } from '../../lib/env-command.ts';
import { readLayer, resolveStack } from '../../lib/env-scopes.ts';

/**
 * One public value. A secret is never read back: the answer for one is that it
 * is secret, and `set` is how it changes.
 */
export const envGet = addEnvTargetOptions(
	new Command('get')
		.description('print a public environment variable')
		.argument('<key>', 'variable name')
		.configureHelp(helpConfig)
).action((key: string, raw: unknown) =>
	runCommand(
		() =>
			withEnvScope(
				raw,
				{
					local: async (ctx) => {
						const value = readLocalEnv(ctx.envFile)[key];
						if (value === undefined) throw new Error(`${key} is not set in .env.`);
						console.log(value);
					},
					instance: async (ctx) => {
						// Resolved the way the instance sees it: a key it does not set itself
						// may still reach it from a shared layer.
						const stack = await resolveStack(ctx.session, ctx.appId, ctx.instance, ctx.preview);
						const entry = stack.entries[key];
						if (!entry) throw new Error(`${key} is not set on ${ctx.targetName}.`);
						if (entry.visibility === 'secret') {
							secret(key, ctx.targetName, entry.layer === 'instance' ? undefined : entry.layer);
							return;
						}
						console.log(entry.value);
					},
					layer: async (ctx) => {
						const contents = await readLayer(ctx.session, ctx.files);
						if (key in contents.public) {
							console.log(contents.public[key]);
							return;
						}
						if (key in contents.secret) {
							secret(key, `${ctx.layer}, ${ctx.server}`);
							return;
						}
						throw new Error(`${key} is not set (${ctx.layer}, ${ctx.server}).`);
					}
				},
				{ label: 'env get' }
			),
		'Failed to read the variable.'
	)
);

function secret(key: string, where: string, from?: string): void {
	p.log.info(
		`${key} is secret ${pc.dim(`(${where}${from ? `, from ${from}` : ''})`)}, so it is not read back.\n` +
			`Set it again to change it: ${pc.cyan(`vela env set ${key}`)}`
	);
	process.exitCode = 1;
}
