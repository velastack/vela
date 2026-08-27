import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addTargetOptions, applyEnvRestart, withTarget } from '../../lib/server-command.ts';
import { readLocalEnvFile, readRemoteEnv, writeRemoteEnv } from '../../lib/remote-env.ts';
import { applyLocalEnvChange, editLocalEnv } from '../../lib/local-env.ts';
import { upsertEnvVar } from '../../lib/env.ts';

export const envImport = addTargetOptions(
	new Command('import')
		.description('merge a dotenv file into the environment')
		.argument('<file>', 'dotenv file to read')
		.configureHelp(helpConfig),
	'local'
).action((file: string, raw: unknown) =>
	runCommand(
		() =>
			withTarget(
				raw,
				{
					local: async (ctx) => {
						const source = resolve(file);
						if (source === ctx.envFile) {
							throw new Error(`${file} is the file you would be importing into.`);
						}
						const incoming = read(source, file);
						const keys = Object.keys(incoming);
						if (keys.length === 0) return;

						p.log.step(`Importing ${keys.length} variable(s) from ${pc.cyan(file)}`);
						editLocalEnv(ctx.envFile, (content) =>
							keys.reduce((acc, key) => upsertEnvVar(acc, key, incoming[key]!), content)
						);
						p.log.success(`${keys.length} variable(s) updated ${pc.dim('(local)')}`);
						await applyLocalEnvChange(ctx, keys);
					},
					remote: async (ctx) => {
						const incoming = read(resolve(file), file);
						const keys = Object.keys(incoming);
						if (keys.length === 0) return;

						p.log.step(`Importing ${keys.length} variable(s) from ${pc.cyan(file)}`);
						// Merge: values on the server that the file does not mention stay put.
						const existing = await readRemoteEnv(ctx.session, ctx.instance);
						await writeRemoteEnv(ctx.session, ctx.instance, { ...existing, ...incoming });

						p.log.success(`${keys.length} variable(s) updated ${pc.dim(`(${ctx.targetName})`)}`);
						await applyEnvRestart(ctx, keys);
					}
				},
				{ label: 'env import' }
			),
		'Failed to import the environment.'
	)
);

function resolve(file: string): string {
	return path.resolve(process.cwd(), file);
}

function read(resolved: string, shown: string): Record<string, string> {
	if (!fs.existsSync(resolved)) throw new Error(`${shown} does not exist.`);
	const incoming = readLocalEnvFile(resolved);
	if (Object.keys(incoming).length === 0) p.log.info(`${shown} has no variables to import.`);
	return incoming;
}
