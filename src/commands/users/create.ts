import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addTargetOptions, withTarget } from '../../lib/server-command.ts';
import { requireRemoteDatabase, withRemotePocketbase } from '../../lib/remote-pocketbase.ts';
import { hasBackend } from '../../lib/workspace.ts';
import { missingBackendMessage } from '../../lib/backend-gate.ts';
import { readInstanceStates } from '../../lib/remote.ts';
import { getPocketbaseMetadata, withPocketbase } from '../../lib/pocketbase.ts';
import { readLocalEnv } from '../../lib/local-env.ts';
import { isInteractive } from '../../lib/providers.ts';
import {
	findUserByEmail,
	generatePassword,
	parseSetPairs,
	readAuthCollection,
	saveAppUser,
	type AppUserOutcome,
	type UsersClient
} from '../../lib/app-users.ts';

export interface UsersCreateFlags {
	collection?: string;
	email?: string;
	password?: string;
	name?: string;
	verified?: boolean;
	set?: string[];
	update?: boolean;
}

export interface UsersCreateResult extends AppUserOutcome {
	email: string;
	collection: string;
	/** Set only when the CLI made the password up, which is the one time it is shown. */
	generatedPassword?: string;
}

function collect(value: string, previous: string[] = []): string[] {
	return [...previous, value];
}

export const usersCreate = addTargetOptions(
	new Command('create')
		.description(
			'create an app user: an account in the app’s own auth collection, for signing in to the app (for the /admin panel, see `vela admin create`)'
		)
		.option('--email <email>', 'email to sign in with — prompted for when omitted')
		.option(
			'--password <password>',
			'password — prompted for when omitted; left empty, one is generated and shown once'
		)
		.option('--name <name>', 'display name, when the collection has a `name` field')
		.option('--verified', 'mark the email as verified (the default for a new account)')
		.option('--no-verified', 'leave the email unverified')
		.option(
			'--set <key=value>',
			'set another field, e.g. --set admin=true; repeat for more',
			collect
		)
		.option('--collection <name>', 'auth collection to create the account in', 'users')
		.option('--update', 'when the email already has an account, change it instead of failing')
		.configureHelp(helpConfig),
	'local'
).action((raw: UsersCreateFlags) =>
	runCommand(
		() =>
			withTarget(
				raw,
				{
					local: async (ctx) => {
						if (!hasBackend(ctx.workspaceRootDir)) {
							throw new Error(missingBackendMessage('vela users create'));
						}
						const creds = readLocalEnv(ctx.envFile);
						const email = creds.POCKETBASE_SUPERUSER_EMAIL;
						const password = creds.POCKETBASE_SUPERUSER_PASSWORD;
						if (!email || !password) {
							throw new Error(
								`The local database is opened as its superuser, and .env has no credentials for one.\n\n` +
									`Set ${pc.cyan('POCKETBASE_SUPERUSER_EMAIL')} and ${pc.cyan('POCKETBASE_SUPERUSER_PASSWORD')} in .env.`
							);
						}

						let result: UsersCreateResult | undefined;
						let base = '';
						await withPocketbase(
							ctx.workspaceRootDir,
							async (pb) => {
								result = await createUser(pb, raw);
								const settings = (await pb.settings.getAll()) as {
									meta?: { appURL?: string };
								};
								base = settings.meta?.appURL ?? '';
							},
							{ email, password },
							// The app's hooks apply to this account as to any other, as they
							// do on a deployed copy and under `vela dev`.
							{ hooks: true }
						);
						if (!base) {
							const metadata = getPocketbaseMetadata(ctx.workspaceRootDir);
							if (metadata) base = `http://${metadata.viteHost}:${metadata.vitePort}`;
						}
						report(result!, base, `once ${pc.cyan('vela dev')} is running`);
					},
					remote: async (ctx) => {
						await requireRemoteDatabase(ctx.session, ctx.instance);
						const [state] = await readInstanceStates(ctx.session, ctx.instance);
						const result = await withRemotePocketbase(ctx.session, ctx.instance, (pb) =>
							createUser(pb, raw)
						);
						const host =
							state?.domain?.split(',')[0]?.trim() || state?.managed?.split(',')[0]?.trim();
						report(
							result,
							state?.url ?? (host ? `https://${host}` : ''),
							'once a domain is configured for this target'
						);
					}
				},
				{ label: 'users create' }
			),
		'Failed to create the user.'
	)
);

/**
 * Ask for whatever the flags left out, then save. Runs with the database
 * already open, because two of the questions depend on it: whether the email
 * is taken (asked before a password is typed for nothing), and whether the
 * collection has a `name` to ask for.
 */
export async function createUser(
	pb: UsersClient,
	flags: UsersCreateFlags,
	interactive: boolean = isInteractive()
): Promise<UsersCreateResult> {
	const collection = await readAuthCollection(pb, flags.collection ?? 'users');
	const set = parseSetPairs(flags.set ?? []);

	let email = flags.email?.trim();
	if (!email) {
		if (!interactive) {
			throw new Error(
				`There is no terminal to ask on. Pass ${pc.cyan('--email <email>')} ` +
					`(and ${pc.cyan('--password <password>')}, or leave it out to have one generated).`
			);
		}
		email = await promptEmail();
	}
	if (!email.includes('@')) throw new Error(`${email} is not an email address.`);

	const existing = await findUserByEmail(pb, collection.name, email);
	if (existing && !flags.update) {
		throw new Error(
			`${email} already has an account in ${collection.name}.\n\n` +
				`Pass ${pc.cyan('--update')} to change its password or fields.`
		);
	}

	let password = flags.password;
	let generatedPassword: string | undefined;
	if (!password) {
		const typed = interactive
			? await promptPassword(collection.minPassword, Boolean(existing))
			: '';
		if (typed) password = typed;
		else if (!existing) {
			generatedPassword = generatePassword();
			password = generatedPassword;
		} else password = undefined;
	}

	let name = flags.name;
	if (name === undefined && interactive && collection.hasName && !existing) {
		name = (await promptName()) || undefined;
	}

	const outcome = await saveAppUser(pb, collection, {
		collection: collection.name,
		email,
		password,
		name,
		verified: flags.verified,
		set,
		update: flags.update
	});
	return { ...outcome, email, collection: collection.name, generatedPassword };
}

function report(result: UsersCreateResult, base: string, otherwise: string): void {
	const who = `${pc.cyan(result.email)} ${pc.dim(`(${result.collection})`)}`;
	if (result.action === 'created') {
		p.log.success(`Created the app user ${who}`);
	} else {
		p.log.success(
			`Updated the app user ${who}` +
				(result.passwordChanged ? '' : pc.dim(' — password left as it was'))
		);
	}
	if (result.generatedPassword) {
		// The only place this ever appears: it is not written to a file, and the
		// database keeps a hash.
		p.log.message(
			`Password: ${result.generatedPassword}\n` +
				pc.dim('Generated because none was given. It is shown this once and stored nowhere else.')
		);
	}
	p.log.info(
		(base
			? `Sign in to the app at ${pc.cyan(base)} ${pc.dim('(/login in a project with `vela enable auth`)')}`
			: `Sign in to the app ${otherwise}.`) +
			`\n${pc.dim('This is an app account, not a login for the /admin panel — that is `vela admin create`.')}`
	);
}

async function promptEmail(): Promise<string> {
	const value = await p.text({
		message: 'Email the user signs in with',
		validate: (input) => (input?.includes('@') ? undefined : 'An email address is required')
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value.trim();
}

async function promptPassword(min: number, existing: boolean): Promise<string> {
	const value = await p.password({
		message: existing
			? 'New password (leave empty to keep the current one)'
			: 'Password (leave empty to generate one)',
		validate: (input) =>
			!input || input.length >= min ? undefined : `At least ${min} characters, or leave it empty`
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value ?? '';
}

async function promptName(): Promise<string> {
	const value = await p.text({ message: 'Name (optional)' });
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return (value ?? '').trim();
}
