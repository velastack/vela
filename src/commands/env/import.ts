import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addServerOptions, applyRestart, withServerContext } from '../../lib/server-command.ts';
import { readLocalEnvFile, readRemoteEnv, writeRemoteEnv } from '../../lib/remote-env.ts';

export const envImport = addServerOptions(
	new Command('import')
		.description('merge a local dotenv file into the production environment')
		.argument('<file>', 'dotenv file to read')
		.configureHelp(helpConfig)
).action((file: string, raw: unknown) =>
	runCommand(
		() =>
			withServerContext(raw, async (ctx) => {
				const resolved = path.resolve(process.cwd(), file);
				if (!fs.existsSync(resolved)) throw new Error(`${file} does not exist.`);

				const incoming = readLocalEnvFile(resolved);
				const keys = Object.keys(incoming);
				if (keys.length === 0) {
					p.log.info(`${file} has no variables to import.`);
					return;
				}

				p.log.step(`Importing ${keys.length} variable(s) from ${pc.cyan(file)}`);
				// Merge: values on the server that the file does not mention stay put.
				const existing = await readRemoteEnv(ctx.session, ctx.instance);
				await writeRemoteEnv(ctx.session, ctx.instance, { ...existing, ...incoming });

				p.log.success(`${keys.length} variable(s) updated`);
				await applyRestart(ctx);
			}),
		'Failed to import the environment.'
	)
);
