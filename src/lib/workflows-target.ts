import process from 'node:process';
import pc from 'picocolors';
import type PocketBase from 'pocketbase';
import { hasBackend } from './workspace.ts';
import { missingBackendMessage, missingCredentialsMessage } from './backend-gate.ts';
import { readLocalEnv } from './local-env.ts';
import { getPocketbaseMetadata, withPocketbase } from './pocketbase.ts';
import { requireRemoteDatabase, withRemotePocketbase } from './remote-pocketbase.ts';
import { withTarget } from './server-command.ts';
import { isHttpStatus, listRuns } from './workflows-api.ts';

export interface WorkflowsContext {
	pb: PocketBase;
	/** A deployed copy of the app, as opposed to the project on this computer. */
	remote: boolean;
	/** How to refer to this copy of the app in output. */
	targetName: string;
	/** ` -t <target>` for commands quoted back, and nothing locally. */
	flag: string;
	/** ` → production (root@host)` after a result, and nothing locally. */
	where: string;
	/**
	 * Whether an app is there to claim runs. Always assumed of a deployed target;
	 * locally only while `vela dev` is up, since the database this command starts
	 * for itself has no app beside it.
	 */
	appRunning: boolean;
}

/**
 * Open the workflow engine of whichever copy of the app `-t` names.
 *
 * Runs live in one database each, so `list`, `run` and `cancel` all go through
 * here: an id listed from one target is only ever acted on in the same one.
 */
export async function withWorkflowsTarget(
	raw: unknown,
	label: string,
	fn: (ctx: WorkflowsContext) => Promise<void>
): Promise<void> {
	await withTarget(
		raw,
		{
			local: async (ctx) => {
				if (!hasBackend(ctx.workspaceRootDir)) {
					throw new Error(missingBackendMessage(`vela ${label}`));
				}

				// Checked here rather than by the program's gate, which `workflows`
				// skips so that acting on a server does not require local credentials.
				// The shell's or CI's win over `.env`, as everywhere else.
				const creds = readLocalEnv(ctx.envFile);
				const email = process.env.POCKETBASE_SUPERUSER_EMAIL || creds.POCKETBASE_SUPERUSER_EMAIL;
				const password =
					process.env.POCKETBASE_SUPERUSER_PASSWORD || creds.POCKETBASE_SUPERUSER_PASSWORD;
				if (!email || !password) throw new Error(missingCredentialsMessage());

				const appRunning = Boolean(getPocketbaseMetadata(ctx.workspaceRootDir)?.pocketbaseUrl);
				await withPocketbase(
					ctx.workspaceRootDir,
					async (pb) => {
						await requireEngine(pb, 'The local PocketBase', '');
						await fn({ pb, remote: false, targetName: 'local', flag: '', where: '', appRunning });
					},
					{ email, password }
				);
			},
			remote: async (ctx) => {
				await requireRemoteDatabase(ctx.session, ctx.instance);
				const flag = ` -t ${ctx.targetName}`;
				await withRemotePocketbase(ctx.session, ctx.instance, async (pb) => {
					await requireEngine(
						pb,
						`The PocketBase deployed to ${ctx.targetName}`,
						`\n\nA deploy brings it up to date: ${pc.cyan(`vela deploy${flag}`)}.`
					);
					await fn({
						pb,
						remote: true,
						targetName: ctx.targetName,
						flag,
						where: ` ${pc.dim('→')} ${pc.cyan(ctx.targetName)} ${pc.dim(`(${ctx.server})`)}`,
						appRunning: true
					});
				});
			}
		},
		{ label }
	);
}

/**
 * Fail early, and legibly, on a PocketBase built before the engine.
 *
 * Asked once up front so that a 404 later can only mean a run that is not
 * there, never a route that is not.
 */
async function requireEngine(pb: PocketBase, subject: string, hint: string): Promise<void> {
	try {
		await listRuns(pb, { limit: 1 });
	} catch (e) {
		if (!isHttpStatus(e, 404)) throw e;
		throw new Error(`${subject} has no workflow engine.${hint}`);
	}
}
