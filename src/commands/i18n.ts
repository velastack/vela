import process from 'node:process';
import { Command } from 'commander';
import { x } from 'tinyexec';
import { detect } from 'package-manager-detector';
import { resolveCommand } from 'package-manager-detector/commands';
import { helpConfig } from '../lib/help.ts';

async function runWuchale(extraArgs: string[]): Promise<void> {
	const cwd = process.cwd();
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
	.action(() => runWuchale([]));

const watch = new Command('watch')
	.description('watch and extract translatable strings')
	.configureHelp(helpConfig)
	.action(() => runWuchale(['--watch']));

const status = new Command('status')
	.description('show i18n status')
	.configureHelp(helpConfig)
	.action(() => runWuchale(['status']));

const clean = new Command('clean')
	.description('clean unused translatable strings')
	.configureHelp(helpConfig)
	.action(() => runWuchale(['--clean']));

export const i18n = new Command('i18n')
	.description('i18n utilities')
	.configureHelp(helpConfig)
	.addCommand(extract, { isDefault: true })
	.addCommand(watch)
	.addCommand(status)
	.addCommand(clean);
