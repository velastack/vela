import pc from 'picocolors';
import type PocketBase from 'pocketbase';
import { hasBackend } from './workspace.ts';
import { readLocalEnv } from './local-env.ts';
import { withPocketbase } from './pocketbase.ts';
import { withRemotePocketbase } from './remote-pocketbase.ts';
import { readInstanceStates } from './remote.ts';
import { withTarget } from './server-command.ts';
import type { SshSession } from './ssh.ts';

export interface BackupContext {
	pb: PocketBase;
	/** The deployed instance's session, or null for the local database. */
	session: SshSession | null;
	/** Instance id on a server, app name locally. Names the archive either way. */
	instance: string;
	/** How to refer to this copy of the app in output. */
	targetName: string;
	workspaceRootDir: string;
}

/**
 * Open whichever database `-t` names, for a command that acts on its backups.
 *
 * The two paths differ only in how PocketBase is reached — a subprocess against
 * `data/` here, a forwarded port there — so every backup subcommand is written
 * once against the handle this yields.
 */
export async function withBackupTarget(
	raw: unknown,
	label: string,
	fn: (ctx: BackupContext) => Promise<void>
): Promise<void> {
	await withTarget(
		raw,
		{
			local: async (ctx) => {
				if (!hasBackend(ctx.workspaceRootDir)) {
					throw new Error(
						`This project has no database, so there is nothing to back up.\n\n` +
							`Run ${pc.cyan('vela bless')} to add a backend.`
					);
				}

				// Read here rather than relying on the process environment: `backup`
				// is a NO_BACKEND command precisely so that acting on a server does
				// not require local credentials, which means nothing has loaded them.
				const creds = readLocalEnv(ctx.envFile);
				const email = creds.POCKETBASE_SUPERUSER_EMAIL;
				const password = creds.POCKETBASE_SUPERUSER_PASSWORD;
				if (!email || !password) {
					throw new Error(
						`The local database has no superuser credentials to sign in with.\n\n` +
							`Set ${pc.cyan('POCKETBASE_SUPERUSER_EMAIL')} and ` +
							`${pc.cyan('POCKETBASE_SUPERUSER_PASSWORD')} in ${pc.cyan('.env')}.`
					);
				}

				await withPocketbase(
					ctx.workspaceRootDir,
					(pb) =>
						fn({
							pb,
							session: null,
							instance: ctx.appName,
							targetName: 'local',
							workspaceRootDir: ctx.workspaceRootDir
						}),
					{ email, password }
				);
			},
			remote: async (ctx) => {
				const [state] = await readInstanceStates(ctx.session, ctx.instance);
				if (state && state.backend === false) {
					throw new Error(
						`${ctx.targetName} was deployed without a database, so it has nothing to back up.`
					);
				}

				await withRemotePocketbase(ctx.session, ctx.instance, (pb) =>
					fn({
						pb,
						session: ctx.session,
						instance: ctx.instance,
						targetName: ctx.targetName,
						workspaceRootDir: ctx.workspaceRootDir
					})
				);
			}
		},
		{ label }
	);
}
