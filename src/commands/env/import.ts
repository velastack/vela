import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { readLocalEnvFile } from '../../lib/remote-env.ts';
import { applyLocalEnvChange, editLocalEnv } from '../../lib/local-env.ts';
import { upsertEnvVar } from '../../lib/env.ts';
import { addEnvTargetOptions, applyChange, withEnvScope } from '../../lib/env-command.ts';
import { importIntoLayer, type ImportOutcome } from '../../lib/env-scopes.ts';

export const envImport = addEnvTargetOptions(
	new Command('import')
		.description('merge a dotenv file into the environment')
		.argument('<file>', 'dotenv file to read')
		.option('--public', 'import as readable values; PUBLIC_* keys are public regardless')
		.configureHelp(helpConfig)
).action((file: string, raw: { public?: boolean }) =>
	runCommand(
		() =>
			withEnvScope(
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
					// Merge: values in the layer that the file does not mention stay put.
					instance: async (ctx) => {
						const incoming = read(resolve(file), file);
						const keys = Object.keys(incoming);
						if (keys.length === 0) return;

						p.log.step(`Importing ${keys.length} variable(s) from ${pc.cyan(file)}`);
						const outcome = await importIntoLayer(
							ctx.session,
							ctx.files,
							incoming,
							raw.public === true
						);
						report(outcome, ctx.targetName);
						await applyChange(ctx.workspaceRootDir, ctx, keys);
					},
					layer: async (ctx) => {
						const incoming = read(resolve(file), file);
						const keys = Object.keys(incoming);
						if (keys.length === 0) return;

						p.log.step(`Importing ${keys.length} variable(s) from ${pc.cyan(file)}`);
						const outcome = await importIntoLayer(
							ctx.session,
							ctx.files,
							incoming,
							raw.public === true
						);
						report(outcome, `${ctx.layer}, ${ctx.server}`);
						await applyChange(ctx.workspaceRootDir, ctx, keys);
					}
				},
				{ label: 'env import', ask: true }
			),
		'Failed to import the environment.'
	)
);

function report(outcome: ImportOutcome, where: string): void {
	const parts = [
		outcome.secret.length ? `${outcome.secret.length} secret` : '',
		outcome.public.length ? `${outcome.public.length} public` : ''
	].filter(Boolean);
	p.log.success(`${parts.join(', ')} variable(s) updated ${pc.dim(`(${where})`)}`);
}

function resolve(file: string): string {
	return path.resolve(process.cwd(), file);
}

function read(resolved: string, shown: string): Record<string, string> {
	if (!fs.existsSync(resolved)) throw new Error(`${shown} does not exist.`);
	const incoming = readLocalEnvFile(resolved);
	if (Object.keys(incoming).length === 0) p.log.info(`${shown} has no variables to import.`);
	return incoming;
}
