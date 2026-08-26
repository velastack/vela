import { Command } from 'commander';
import * as v from 'valibot';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { getWorkspace } from './workspace.ts';
import { loadDeployConfig, resolveAppIdentity, resolveTarget } from './deploy-config.ts';
import { instanceId, normalizeEnvTag } from './instance.ts';
import { addSshOptions, SSH_OPTION_SCHEMA, sshOptionsFrom } from './ssh-options.ts';
import { parseOptions } from './options.ts';
import { withSsh, type SshSession } from './ssh.ts';
import { requireProvisioned, syncServerScripts } from './remote.ts';
import { restartInstance } from './remote-env.ts';

export const SERVER_OPTIONS_SCHEMA = {
	...SSH_OPTION_SCHEMA,
	env: v.optional(v.string()),
	target: v.optional(v.string())
};

const OptionsSchema = v.object(SERVER_OPTIONS_SCHEMA);

export function addServerOptions(command: Command): Command {
	return addSshOptions(command)
		.option('-e, --env <tag>', 'environment to act on', 'prod')
		.option('-t, --target <ssh>', 'SSH target (defaults to where this app was last deployed)');
}

export interface ServerContext {
	session: SshSession;
	instance: string;
	envTag: string;
	target: string;
	appName: string;
}

/**
 * Resolve the project, work out which instance is meant, and open a session.
 *
 * Every project-scoped server command runs through here, so provisioning
 * checks, target resolution and instance naming exist in exactly one place.
 */
export async function withServerContext(
	raw: unknown,
	fn: (ctx: ServerContext) => Promise<void>,
	explicitTarget?: string
): Promise<void> {
	const options = parseOptions(OptionsSchema, raw);
	const { workspaceRootDir } = await getWorkspace();
	const config = await loadDeployConfig(workspaceRootDir);
	// Minting the app id here rather than demanding a prior deploy is what lets
	// `vela env import` run before the first `vela deploy`, which is the order
	// that gets an app its secrets before it ever serves a request.
	const app = resolveAppIdentity(workspaceRootDir, config);

	const envTag = normalizeEnvTag(options.env);
	const target = resolveTarget(workspaceRootDir, envTag, explicitTarget ?? options.target);
	const instance = instanceId(app.appId, envTag);

	await withSsh(target, sshOptionsFrom(options), async (session) => {
		await session.detectElevation();
		await requireProvisioned(session);
		// Keep the server's copy of the scripts in step with this CLI, so a
		// command never runs against a script from an older version.
		await syncServerScripts(session);
		await fn({ session, instance, envTag, target, appName: app.name });
	});
}

/** Restart after a change, reporting the two outcomes separately. */
export async function applyRestart(ctx: ServerContext): Promise<void> {
	const outcome = await restartInstance(ctx.session, ctx.instance);
	if (!outcome.deployed) return;
	if (outcome.restarted) {
		p.log.success('App restarted');
		return;
	}
	p.log.error(
		`App restart failed.\n\n` +
			`The new value is stored and will be used the next time the app starts.\n` +
			`${pc.dim(outcome.error ?? '')}`
	);
}

/**
 * Open a session against a server without needing a vela project in the current
 * directory — `vela status myserver --all` is a server-wide question.
 */
export async function withServer(
	target: string | undefined,
	raw: unknown,
	fn: (session: SshSession) => Promise<void>
): Promise<void> {
	const options = parseOptions(OptionsSchema, raw);
	const resolved = target ?? options.target ?? (await targetFromProject(options.env));
	await withSsh(resolved, sshOptionsFrom(options), async (session) => {
		await session.detectElevation();
		await requireProvisioned(session);
		await syncServerScripts(session);
		await fn(session);
	});
}

async function targetFromProject(envTag: string | undefined): Promise<string> {
	const { workspaceRootDir } = await getWorkspace();
	return resolveTarget(workspaceRootDir, normalizeEnvTag(envTag));
}
