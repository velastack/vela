import process from 'node:process';
import * as v from 'valibot';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { parseOptions } from '../../lib/options.ts';
import { getWorkspace, type Ui } from '../../lib/workspace.ts';
import { upsertSuperuser } from '../../lib/pocketbase.ts';
import { upsertEnvFile } from '../../lib/env.ts';
import { isInteractive } from '../../lib/providers.ts';
import {
	decideSuperuser,
	emailFlag,
	passwordFlag,
	promptSuperuser,
	superuserFromEnv,
	type Credentials
} from '../../lib/superuser.ts';

const optionsSchema = v.strictObject({
	email: emailFlag,
	password: passwordFlag
});

export const backend = new Command('backend')
	.description('enable the PocketBase backend')
	.option('--email <email>', 'email of the admin user')
	.option('--password <password>', 'password of the admin user')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((rawOpts, cmd) =>
		runCommand(async () => {
			const options = parseOptions(optionsSchema, rawOpts);
			const { workspaceRootDir, features } = await getWorkspace();

			// Asked before anything is installed or rewritten, the way `vela create`
			// and `vela bless` ask: cancelling at a prompt leaves the project alone.
			const credentials = await resolveCredentials(options);

			await runPattern(
				'enable-backend',
				cmd.args,
				{},
				{
					summary: 'Enabled the PocketBase backend.',
					nextSteps: backendNextSteps(features.ui),
					task: {
						title: 'Enabling backend',
						success: 'Enabled backend',
						error: 'Failed to enable backend'
					}
				},
				// The pattern installs `pocketbase-server` before this runs, and
				// scaffolds the `data/` directory the database lives in.
				() => initPocketbase(workspaceRootDir, credentials)
			);
		}, 'Failed to enable backend.')
	);

/**
 * `enable auth` emits shadcn-svelte pages and refuses a project without it, so a
 * project vela did not create is pointed at what works there instead: a
 * scaffold, which falls back to plain HTML, and the server tests it writes.
 */
export function backendNextSteps(ui: Ui): string[] {
	const dev =
		'Run `vela dev` — PocketBase starts alongside the app, with its admin interface at /admin.';
	if (ui === 'shadcn') {
		return [
			dev,
			'Run `vela enable auth` to add user authentication on top of the backend.',
			'Run `vela generate scaffold <model>` to scaffold your first CRUD pages.'
		];
	}
	return [
		dev,
		'Run `vela generate scaffold <model> <fields...>` to add a collection with CRUD pages in plain HTML.',
		'Run `vela test:server` to run the server tests that come with it.',
		'`vela enable auth` needs shadcn-svelte: `npx sv add tailwindcss`, then `npx shadcn-svelte@latest init`.'
	];
}

/**
 * Give the new database a superuser and record it in `.env`, exactly as
 * `vela create` does for a backend template — without it `vela dev` starts a
 * PocketBase nothing can authenticate against, and every other command stops at
 * the missing-credentials guard.
 */
async function initPocketbase(root: string, { email, password }: Credentials): Promise<void> {
	p.log.step('Initializing PocketBase...');
	await upsertSuperuser(root, email, password);

	upsertEnvFile(
		root,
		{
			POCKETBASE_SUPERUSER_EMAIL: email,
			POCKETBASE_SUPERUSER_PASSWORD: password
		},
		['PocketBase superuser credentials — used by `vela` commands']
	);

	p.log.success(`PocketBase initialized, credentials written to ${pc.bold('.env')}`);
}

async function resolveCredentials(options: {
	email?: string;
	password?: string;
}): Promise<Credentials> {
	const decision = decideSuperuser(options, superuserFromEnv(), isInteractive());

	if (decision.kind === 'error') throw new Error(decision.message);

	if (decision.kind === 'use') {
		if (decision.reused) {
			p.log.info(
				`Using the superuser credentials already in your environment (${pc.cyan(decision.credentials.email)}).`
			);
		}
		return decision.credentials;
	}

	return promptSuperuser(decision.known, () => {
		p.cancel('Operation cancelled.');
		process.exit(0);
	});
}
