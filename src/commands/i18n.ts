import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import { x } from 'tinyexec';
import { detect } from 'package-manager-detector';
import { resolveCommand } from 'package-manager-detector/commands';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { findWorkspaceRoot } from '../lib/workspace.ts';

/** The names wuchale tries when no `--config` is given. */
const WUCHALE_CONFIG_NAMES = ['js', 'mjs', 'ts', 'mts'].map((ext) => `wuchale.config.${ext}`);

async function runWuchale(extraArgs: string[]): Promise<void> {
	// wuchale resolves its config against its cwd. Running it from the project
	// root keeps a subdirectory from looking like a project without i18n.
	const cwd = findWorkspaceRoot() ?? process.cwd();
	if (!WUCHALE_CONFIG_NAMES.some((name) => fs.existsSync(path.join(cwd, name)))) {
		throw new Error('No wuchale config found. Run `vela enable i18n` to set up i18n.');
	}
	const pm = (await detect({ cwd }))?.name ?? 'npm';
	const resolved = resolveCommand(pm, 'execute', ['wuchale', ...extraArgs])!;
	const args = resolved.args.slice();
	if (pm === 'npm') args.unshift('--yes');
	await x(resolved.command, args, {
		nodeOptions: { cwd, stdio: 'inherit' },
		throwOnError: true
	});
}

const extract = new Command('extract')
	.description('extract translatable strings')
	.configureHelp(helpConfig)
	.action(() => runCommand(() => runWuchale([])));

const watch = new Command('watch')
	.description('watch and extract translatable strings')
	.configureHelp(helpConfig)
	.action(() => runCommand(() => runWuchale(['--watch'])));

const status = new Command('status')
	.description('show i18n status')
	.configureHelp(helpConfig)
	.action(() => runCommand(() => runWuchale(['status'])));

const clean = new Command('clean')
	.description('clean unused translatable strings')
	.configureHelp(helpConfig)
	.action(() => runCommand(() => runWuchale(['--clean'])));

export const i18n = new Command('i18n')
	.description('i18n utilities')
	.configureHelp(helpConfig)
	.addCommand(extract, { isDefault: true })
	.addCommand(watch)
	.addCommand(status)
	.addCommand(clean);
