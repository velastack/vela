import process from 'node:process';
import * as p from '@clack/prompts';
import { Command } from 'commander';
import nodePath from 'node:path';
import dotenv from 'dotenv';
import pc from 'picocolors';
import pkg from '../package.json' with { type: 'json' };
import { helpConfig } from './lib/help.ts';
import { isStub } from './lib/stub.ts';
import { findWorkspaceRoot, hasBackend } from './lib/workspace.ts';
import { bless } from './commands/bless.ts';
import { create } from './commands/create.ts';
import { generate } from './commands/generate.ts';
import { enable } from './commands/enable.ts';
import { disable } from './commands/disable.ts';
import { destroy } from './commands/destroy.ts';
import { ui } from './commands/ui.ts';
import { legal } from './commands/legal.ts';
import { fixtures } from './commands/fixtures.ts';
import { seeds } from './commands/seeds.ts';
import { signup } from './commands/signup.ts';
import { login } from './commands/login.ts';
import { logout } from './commands/logout.ts';
import { whoami } from './commands/whoami.ts';
import { migrate } from './commands/migrate.ts';
import { dev } from './commands/dev.ts';
import { build } from './commands/build.ts';
import { preview } from './commands/preview.ts';
import { sync } from './commands/sync.ts';
import { provision } from './commands/provision.ts';
import { deploy } from './commands/deploy.ts';
import { link } from './commands/link.ts';
import { env } from './commands/env.ts';
import { status } from './commands/status.ts';
import { rollback } from './commands/rollback.ts';
import { logs } from './commands/logs.ts';
import { admin } from './commands/admin.ts';
import { backup } from './commands/backup.ts';
import { restore } from './commands/restore.ts';
import { targets } from './commands/targets.ts';
import { testServer } from './commands/test.ts';
import { routes } from './commands/routes.ts';
import { i18n } from './commands/i18n.ts';
import { oauth } from './commands/oauth.ts';
import { schemas } from './commands/schemas.ts';

/**
 * Commands that never touch the database, whether or not the project has one.
 */
const NO_BACKEND_COMMMANDS = new Set([
	'bless',
	'create',
	'signup',
	'login',
	'logout',
	'whoami',
	'legal',
	'ui',
	'routes',
	'i18n',
	'generate schema',
	'generate form',
	// Server commands talk to a VPS over SSH, never to the local database.
	'provision',
	'env',
	'status',
	'rollback',
	'logs',
	'admin',
	'targets',
	'link',
	// Acts on whichever target `-t` names; the local path reads the project's
	// own credentials rather than requiring them in this process.
	'backup',
	'restore'
]);

/**
 * Commands that drive the frontend build and so work with or without a backend.
 * In a backend project they still start PocketBase, which is why they are not in
 * NO_BACKEND_COMMMANDS.
 */
const BACKEND_OPTIONAL_COMMANDS = new Set(['dev', 'build', 'preview', 'deploy']);

export const program = new Command()
	.name(pkg.name)
	.description(pkg.description)
	.version(pkg.version, '-v, --version')
	.configureHelp(helpConfig);

program.hook('preAction', (_thisCommand, actionCommand) => {
	if (isStub(actionCommand)) return;

	// Resolved from the workspace root rather than the cwd: dotenv's default
	// would miss `.env` for anything run from a subdirectory, which `-t local`
	// makes visible the moment a command reads or writes it.
	const envRoot = findWorkspaceRoot() ?? process.cwd();
	dotenv.config({ path: nodePath.join(envRoot, '.env'), quiet: true });

	const path = getCommandPath(actionCommand);
	if (NO_BACKEND_COMMMANDS.has(path)) return;
	const top = path.split(' ', 1)[0];
	if (NO_BACKEND_COMMMANDS.has(top)) return;

	// A static project has no PocketBase, so there are no credentials to ask for.
	// Frontend commands carry on; anything that needs the database says so plainly
	// rather than sending the user off to look for a .env that would not help.
	if (!hasBackend()) {
		if (BACKEND_OPTIONAL_COMMANDS.has(top)) return;

		p.log.error(
			`${pc.cyan(`vela ${path}`)} needs a backend, and this project does not have one.\n\n` +
				`Static projects have no database to talk to.\n\n` +
				`To add a backend to this project, run ${pc.cyan('vela bless')}.`
		);
		p.log.message();
		p.cancel('Operation failed.');
		process.exit(1);
	}

	if (!process.env.POCKETBASE_SUPERUSER_EMAIL || !process.env.POCKETBASE_SUPERUSER_PASSWORD) {
		p.log.error(
			`PocketBase superuser credentials are required.\n\n` +
				`Set ${pc.cyan('POCKETBASE_SUPERUSER_EMAIL')} and ${pc.cyan('POCKETBASE_SUPERUSER_PASSWORD')} in your .env file.\n\n` +
				`To set up a new project, run ${pc.cyan('vela create')}.\n` +
				`To set up an existing project, run ${pc.cyan('vela bless')}.`
		);
		p.log.message();
		p.cancel('Operation failed.');
		process.exit(1);
	}
});

function getCommandPath(cmd: Command): string {
	const names: string[] = [];
	let current: Command | null = cmd;
	while (current && current.parent) {
		names.unshift(current.name());
		current = current.parent;
	}
	return names.join(' ');
}

for (const command of [
	bless,
	create,
	generate,
	enable,
	disable,
	destroy,
	ui,
	legal,
	fixtures,
	seeds,
	signup,
	login,
	logout,
	whoami,
	migrate,
	dev,
	build,
	preview,
	sync,
	provision,
	deploy,
	rollback,
	status,
	logs,
	env,
	admin,
	backup,
	restore,
	targets,
	link,
	testServer,
	routes,
	i18n,
	oauth,
	schemas
]) {
	program.addCommand(command);
}
