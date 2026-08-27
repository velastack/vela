import process from 'node:process';
import { Command } from 'commander';
import * as v from 'valibot';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { getWorkspace } from './workspace.ts';
import {
	loadDeployConfig,
	readBinding,
	resolveAppIdentity,
	writeBinding,
	type TargetBinding,
	type VelaAppConfig
} from './deploy-config.ts';
import { instanceId } from './instance.ts';
import { addSshOptions, SSH_OPTION_SCHEMA, sshOptionsFrom } from './ssh-options.ts';
import { parseOptions } from './options.ts';
import { withSsh, type SshSession } from './ssh.ts';
import { requireProvisioned, syncServerScripts } from './remote.ts';
import { restartInstance, touchesSuperuser } from './remote-env.ts';
import {
	describeTarget,
	parseTarget,
	type RemoteTarget,
	type Target,
	type TargetFallback
} from './target.ts';

export const SERVER_OPTIONS_SCHEMA = {
	...SSH_OPTION_SCHEMA,
	target: v.optional(v.string()),
	server: v.optional(v.string())
};

const OptionsSchema = v.object(SERVER_OPTIONS_SCHEMA);

/**
 * The one selector.
 *
 * `fallback` is registered as commander's default so `--help` states what the
 * command means with no `-t`, rather than leaving it to prose.
 */
export function addTargetOptions(command: Command, fallback: TargetFallback): Command {
	return addSshOptions(command)
		.option('-t, --target <target>', 'which copy of the app to act on', fallback)
		.option('--server <ssh>', 'server this target runs on — recorded on first use');
}

interface BaseContext {
	workspaceRootDir: string;
	appName: string;
	appId: string;
	config: VelaAppConfig;
}

export interface LocalContext extends BaseContext {
	kind: 'local';
	/** Always the workspace root's, never the cwd's. */
	envFile: string;
}

export interface ServerContext extends BaseContext {
	kind: 'remote';
	session: SshSession;
	instance: string;
	envTag: string;
	/** The target as the user named it, for output. */
	targetName: string;
	/** SSH destination behind that target. */
	server: string;
	binding: TargetBinding;
}

export interface TargetHandlers {
	local?: (ctx: LocalContext) => Promise<void>;
	remote?: (ctx: ServerContext) => Promise<void>;
}

export interface TargetRunOptions {
	/** `--project`, forwarded to identity resolution. */
	project?: string;
	/** Ask for a domain when binding. Only `deploy` acts on one. */
	askDomain?: boolean;
	/** Command name for errors, e.g. `env set`. */
	label?: string;
	/** What to point at instead when there is no local mode. */
	localHint?: string;
}

/**
 * Run a command against whichever copy of the app `-t` names.
 *
 * A command declares what it supports by which handlers it passes, so the
 * declaration *is* the branch: a remote-only command writes one handler and gets
 * a good error for `-t local` for free, and `ctx.session` exists only inside the
 * remote handler, so a local path cannot reach SSH even by accident.
 */
export async function withTarget(
	raw: unknown,
	handlers: TargetHandlers,
	run: TargetRunOptions = {}
): Promise<void> {
	const options = parseOptions(OptionsSchema, raw);
	const target = parseTarget(options.target, 'production');
	const label = run.label ? `vela ${run.label}` : 'this command';

	if (target.kind === 'preview') {
		throw new Error(
			`Preview targets are not supported yet.\n\n` +
				`\`${describeTarget(target)}\` parses, but nothing deploys it: previews need wildcard\n` +
				`DNS and certificates that \`vela provision\` does not set up yet.`
		);
	}

	const { workspaceRootDir } = await getWorkspace();
	const config = await loadDeployConfig(workspaceRootDir);
	// Minting the app id here rather than demanding a prior deploy is what lets
	// `vela env import` run before the first `vela deploy`, which is the order
	// that gets an app its secrets before it ever serves a request.
	const app = resolveAppIdentity(workspaceRootDir, {
		...config,
		project: run.project ?? config.project
	});
	const base = {
		workspaceRootDir,
		appName: app.name,
		appId: app.appId,
		config
	};

	if (target.kind === 'local') {
		if (!handlers.local) {
			throw new Error(
				`${label} has no local target.` + (run.localHint ? `\n\n${run.localHint}` : '')
			);
		}
		await handlers.local({
			...base,
			kind: 'local',
			envFile: envFilePath(workspaceRootDir)
		});
		return;
	}

	if (!handlers.remote) {
		throw new Error(`${label} only acts on ${pc.cyan('local')}.`);
	}

	const binding = await ensureBinding(workspaceRootDir, target, {
		server: options.server,
		askDomain: run.askDomain
	});

	await withSsh(binding.server, sshOptionsFrom(options), async (session) => {
		await session.detectElevation();
		await requireProvisioned(session);
		// Keep the server's copy of the scripts in step with this CLI, so a
		// command never runs against a script from an older version.
		await syncServerScripts(session);
		await handlers.remote!({
			...base,
			kind: 'remote',
			session,
			instance: instanceId(app.appId, target.envTag),
			envTag: target.envTag,
			targetName: target.name,
			server: binding.server,
			binding
		});
	});
}

export interface BindingRequest {
	server?: string;
	domain?: string;
	askDomain?: boolean;
}

/**
 * Work out which server a target runs on, binding it on first use.
 *
 * A target is a name; the machine behind it is recorded once and then never
 * retyped. `--server` is the non-interactive way in, which is what CI passes; a
 * terminal is asked instead, so `vela create` straight into `vela deploy` works
 * with nothing to look up.
 */
export async function ensureBinding(
	workspaceRootDir: string,
	target: RemoteTarget,
	request: BindingRequest = {}
): Promise<TargetBinding> {
	const existing = readBinding(workspaceRootDir, target.envTag);
	const moving = Boolean(request.server && existing && existing.server !== request.server);

	let server = request.server ?? existing?.server;
	if (!server) {
		server = await promptServer(target);
	}

	let domain = request.domain ?? existing?.domain;
	if (!domain && request.askDomain && !request.server) {
		domain = await promptDomain(target);
	}

	const binding: TargetBinding = domain ? { server, domain } : { server };
	if (!existing || existing.server !== server || existing.domain !== domain) {
		writeBinding(workspaceRootDir, target.envTag, binding);
	}

	if (moving) {
		p.log.warn(
			`${pc.cyan(target.name)} now points at ${pc.cyan(server)}.\n\n` +
				`Whatever is running on ${existing!.server} is left there, and this project can no\n` +
				`longer reach it. Remove it there first if that was not intended.`
		);
	}

	return binding;
}

async function promptServer(target: RemoteTarget): Promise<string> {
	if (!process.stdout.isTTY || process.env.CI) {
		throw new Error(
			`${target.name} is not bound to a server yet, and there is no terminal to ask on.\n\n` +
				`Pass ${pc.cyan('--server user@host')}, or run the command once from your own machine\n` +
				`and commit ${pc.cyan('.vela/project.json')}.`
		);
	}

	p.log.info(`${pc.cyan(target.name)} is not bound to a server yet.`);
	const value = await p.text({
		message: `Which server should ${target.name} run on?`,
		placeholder: 'root@203.0.113.10',
		validate: (input) => (input?.trim() ? undefined : 'An ssh_config alias, or user@host')
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value.trim();
}

async function promptDomain(target: RemoteTarget): Promise<string | undefined> {
	if (!process.stdout.isTTY || process.env.CI) return undefined;

	const value = await p.text({
		message: `Which hostname should ${target.name} be served on?`,
		placeholder: 'example.com — leave blank to decide later'
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value.trim() || undefined;
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
 * Restart after an env change, unless it touched the PocketBase superuser.
 *
 * Those two values are only half of the credential — the other half is a record
 * in the instance's database, which `vela deploy` reconciles. Restarting here
 * would pick up a password the database does not know yet and fail every
 * request, so the change is stored and the restart deferred.
 */
export async function applyEnvRestart(ctx: ServerContext, changed: string[]): Promise<void> {
	if (touchesSuperuser(changed)) {
		p.log.warn(
			`PocketBase superuser credentials changed.\n\n` +
				`The database still holds the old ones, so the app has not been restarted.\n` +
				`Run ${pc.cyan('vela deploy')} to push them into the database and restart.`
		);
		return;
	}
	await applyRestart(ctx);
}

/**
 * Open a session against a server without naming an instance — `vela status
 * --all` is a question about the machine, not about one app.
 */
export async function withServerSession(
	raw: unknown,
	fn: (session: SshSession) => Promise<void>
): Promise<void> {
	const options = parseOptions(OptionsSchema, raw);

	let server = options.server;
	if (!server) {
		const { workspaceRootDir } = await getWorkspace();
		const target = parseTarget(options.target, 'production');
		if (target.kind !== 'remote') {
			throw new Error(`${describeTarget(target)} does not run on a server.`);
		}
		server = (await ensureBinding(workspaceRootDir, target, { server: options.server })).server;
	}

	await withSsh(server, sshOptionsFrom(options), async (session) => {
		await session.detectElevation();
		await requireProvisioned(session);
		await syncServerScripts(session);
		await fn(session);
	});
}

function envFilePath(workspaceRootDir: string): string {
	return `${workspaceRootDir}/.env`;
}
