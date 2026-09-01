import process from 'node:process';
import type PocketBase from 'pocketbase';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addTargetOptions, withTarget } from '../../lib/server-command.ts';
import { withRemotePocketbase } from '../../lib/remote-pocketbase.ts';
import { readInstanceStates } from '../../lib/remote.ts';
import { getPocketbaseMetadata, withPocketbase } from '../../lib/pocketbase.ts';
import { readLocalEnv } from '../../lib/local-env.ts';

/** PocketBase's own minimum for a superuser password. */
const MIN_PASSWORD = 10;

export const adminCreate = addTargetOptions(
	new Command('create')
		.description('create a login for the admin panel')
		.argument('[email]', 'email to sign in with — prompted for when omitted')
		.configureHelp(helpConfig),
	'local'
).action((email: string | undefined, raw: unknown) =>
	runCommand(
		() =>
			withTarget(
				raw,
				{
					local: async (ctx) => {
						const creds = readLocalEnv(ctx.envFile);
						const address = email ?? (await promptEmail());
						const password = await promptPassword();

						let signIn = '';
						await withPocketbase(
							ctx.workspaceRootDir,
							async (pb) => {
								await upsertSuperuser(pb, address, password);
								// `vela dev` writes the real URL into PocketBase settings on every
								// boot, and it survives dev exiting — a better source than the
								// metadata file, which is deleted when dev stops.
								const settings = (await pb.settings.getAll()) as {
									meta?: { appURL?: string };
								};
								signIn = settings.meta?.appURL ?? '';
							},
							{
								email: creds.POCKETBASE_SUPERUSER_EMAIL,
								password: creds.POCKETBASE_SUPERUSER_PASSWORD
							}
						);

						if (!signIn) {
							const metadata = getPocketbaseMetadata(ctx.workspaceRootDir);
							if (metadata) signIn = `http://${metadata.viteHost}:${metadata.vitePort}`;
						}

						p.log.info(
							signIn
								? `Sign in at ${pc.cyan(`${signIn}/admin`)}`
								: `Sign in at ${pc.cyan('/admin')} once ${pc.cyan('vela dev')} is running.`
						);
					},
					remote: async (ctx) => {
						const address = email ?? (await promptEmail());
						const password = await promptPassword();
						const [state] = await readInstanceStates(ctx.session, ctx.instance);

						await withRemotePocketbase(ctx.session, ctx.instance, (pb) =>
							upsertSuperuser(pb, address, password)
						);

						// The panel is served by the app itself, at the adapter's `/admin`,
						// so it is reachable wherever the app is — PocketBase itself never
						// leaves the server's loopback.
						const base = state?.domain ? `https://${state.domain.split(',')[0]!.trim()}` : '';
						p.log.info(
							base
								? `Sign in at ${pc.cyan(`${base}/admin`)}`
								: `Sign in at ${pc.cyan('/admin')} once a domain is configured for this target.`
						);
					}
				},
				{ label: 'admin create' }
			),
		'Failed to create the admin login.'
	)
);

/**
 * Create the login, or reset its password when the email already signs in.
 *
 * Shared by both targets so a local account and a deployed one are made the same
 * way, against whichever PocketBase the caller opened.
 */
async function upsertSuperuser(pb: PocketBase, email: string, password: string): Promise<void> {
	const existing = await findSuperuser(pb, email);
	if (existing) {
		const confirmed = await p.confirm({
			message: `${email} already has an account, update its password?`,
			initialValue: false
		});
		if (p.isCancel(confirmed) || !confirmed) {
			p.cancel('Operation cancelled.');
			process.exit(0);
		}
		await pb.collection('_superusers').update(existing, { password, passwordConfirm: password });
		p.log.success(`Password updated for ${pc.cyan(email)}, you can sign in now`);
		return;
	}

	await pb.collection('_superusers').create({ email, password, passwordConfirm: password });
	p.log.success(`${pc.cyan(email)} can now sign in`);
}

/**
 * The account this creates is the human's, and deliberately separate from the
 * superuser the app authenticates as: that one is generated on the server, kept
 * in the instance environment and never printed. Two accounts, so a person can
 * be given or denied access without touching what the app runs on.
 */
async function findSuperuser(pb: PocketBase, email: string): Promise<string | null> {
	try {
		const record = await pb
			.collection('_superusers')
			.getFirstListItem(pb.filter('email = {:email}', { email }));
		return record.id;
	} catch {
		return null;
	}
}

async function promptEmail(): Promise<string> {
	const value = await p.text({
		message: 'Email to sign in with',
		validate: (input) => (input?.includes('@') ? undefined : 'An email address is required')
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value.trim();
}

async function promptPassword(): Promise<string> {
	const value = await p.password({
		message: 'Password',
		validate: (input) =>
			(input?.length ?? 0) >= MIN_PASSWORD
				? undefined
				: `At least ${MIN_PASSWORD} characters is required`
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}

	const again = await p.password({
		message: 'Password again',
		validate: (input) => (input === value ? undefined : 'The two do not match')
	});
	if (p.isCancel(again)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value;
}
