import process from 'node:process';
import { Command } from 'commander';
import * as v from 'valibot';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { getWorkspace } from './workspace.ts';
import { readAppIdentity, readBindings, resolveAppIdentity } from './deploy-config.ts';
import { instanceId, PROD_ENV } from './instance.ts';
import { addSshOptions, SSH_OPTION_SCHEMA, sshOptionsFrom } from './ssh-options.ts';
import { parseOptions } from './options.ts';
import { withSsh, type SshSession } from './ssh.ts';
import { readInstanceStates, requireProvisioned, type InstanceState } from './remote.ts';
import { restartInstance, touchesSuperuser } from './remote-env.ts';
import { layerFiles, reachedInstances, type LayerFiles } from './env-scopes.ts';
import { isInteractive } from './providers.ts';
import { staticEnvImports } from './static-env.ts';
import {
	parseTarget,
	PRODUCTION_TARGET,
	type PreviewTarget,
	type RemoteTarget,
	TargetError
} from './target.ts';
import {
	withTarget,
	applyEnvRestart,
	type LocalContext,
	type ServerContext
} from './server-command.ts';

/**
 * Where an env command acts. Two more than other commands have: `all`, the
 * layer every deployed target shares, and a bare `preview`, the layer every
 * preview shares — for `deploy`, `preview` means the branch checked out here.
 */
export type EnvScope =
	| { kind: 'local' }
	| { kind: 'all' }
	| { kind: 'preview' }
	| { kind: 'instance'; target: RemoteTarget | PreviewTarget };

export const ALL_SCOPE = 'all';
const PREVIEW_SCOPE = 'preview';

export function parseEnvScope(raw: string | undefined): EnvScope | null {
	const value = raw?.trim();
	if (!value) return null;
	const lower = value.toLowerCase();
	if (lower === ALL_SCOPE) return { kind: 'all' };
	if (lower === PREVIEW_SCOPE) return { kind: 'preview' };
	const target = parseTarget(value, 'local');
	if (target.kind === 'local') return { kind: 'local' };
	return { kind: 'instance', target };
}

/** How a scope reads back in output. */
export function describeScope(scope: EnvScope): string {
	switch (scope.kind) {
		case 'local':
			return 'local';
		case 'all':
			return 'every server';
		case 'preview':
			return 'every preview';
		case 'instance':
			return scope.target.kind === 'preview'
				? `preview:${scope.target.branch ?? ''}`
				: scope.target.name;
	}
}

const OptionsSchema = v.object({
	...SSH_OPTION_SCHEMA,
	target: v.optional(v.string()),
	server: v.optional(v.string())
});

/**
 * `-t` without a default: an env command that is not told where to act asks,
 * rather than writing to one place because that was the fallback.
 */
export function addEnvTargetOptions(command: Command): Command {
	return addSshOptions(command)
		.option(
			'-t, --target <target>',
			`which environment: ${['local', ALL_SCOPE, PREVIEW_SCOPE, 'preview:<branch>', PRODUCTION_TARGET, '<target>'].join(', ')}`
		)
		.option('--server <ssh>', 'server this target runs on — recorded on first use');
}

export interface LayerContext {
	kind: 'layer';
	workspaceRootDir: string;
	layer: 'all' | 'preview';
	session: SshSession;
	server: string;
	appId: string;
	files: LayerFiles;
	/** Instances of this app on this server the layer applies to. */
	reached: InstanceState[];
}

export interface InstanceEnvContext extends ServerContext {
	files: LayerFiles;
	preview: boolean;
}

export interface EnvHandlers {
	local?: (ctx: LocalContext) => Promise<void>;
	layer?: (ctx: LayerContext) => Promise<void>;
	instance?: (ctx: InstanceEnvContext) => Promise<void>;
}

export interface EnvRunOptions {
	label: string;
	/** Ask for the scope when `-t` is missing, rather than refusing. */
	ask?: boolean;
}

/**
 * Run an env command against the scope `-t` names.
 *
 * A shared layer lives on every server the project's targets are bound to, so
 * `all` and `preview` visit each of them in turn; an instance scope goes through
 * the same `withTarget` every other command uses.
 */
export async function withEnvScope(
	raw: unknown,
	handlers: EnvHandlers,
	run: EnvRunOptions
): Promise<void> {
	const options = parseOptions(OptionsSchema, raw);
	const { workspaceRootDir } = await getWorkspace();
	const label = `vela ${run.label}`;

	let scope = parseEnvScope(options.target);
	if (!scope) {
		if (!run.ask)
			throw new TargetError(`${label} needs ${pc.cyan('-t')} to say which environment.`);
		scope = await promptScope(workspaceRootDir, label);
	}

	if (scope.kind === 'local' || scope.kind === 'instance') {
		if (scope.kind === 'local' && !handlers.local) {
			throw new TargetError(`${label} has no local target.`);
		}
		if (scope.kind === 'instance' && !handlers.instance) {
			throw new TargetError(`${label} only acts on a shared layer.`);
		}
		const target = scope.kind === 'local' ? 'local' : describeScope(scope);
		await withTarget(
			{ ...(raw as object), target },
			{
				local: handlers.local,
				remote: handlers.instance
					? async (ctx) => {
							const preview = ctx.target.kind === 'preview';
							await handlers.instance!({
								...ctx,
								preview,
								files: layerFiles(ctx.appId, 'instance', ctx.instance)
							});
						}
					: undefined
			},
			{ label: run.label }
		);
		return;
	}

	if (!handlers.layer) throw new TargetError(`${label} acts on one target at a time.`);
	const layer = scope.kind;
	// Servers first: a project that has never deployed has nowhere to write, and
	// must not be left with a freshly minted app id for having asked.
	const servers = serversFor(workspaceRootDir, layer);
	if (servers.length === 0) {
		throw new TargetError(
			layer === 'all'
				? `No target is bound to a server yet, so there is nowhere to write.\n\n` +
						`Deploy once (${pc.cyan('vela deploy --server user@host')}) and the app-wide layer goes to every server it is deployed to.`
				: `Previews are not bound to a server yet.\n\n` +
						`Deploy one first: ${pc.cyan('vela deploy -t preview --server user@host')}.`
		);
	}

	const app = resolveAppIdentity(workspaceRootDir);
	for (const server of servers) {
		await withSsh(server, sshOptionsFrom(options), async (session) => {
			await session.detectElevation();
			await requireProvisioned(session);
			const states = await readInstanceStates(session);
			await handlers.layer!({
				kind: 'layer',
				workspaceRootDir,
				layer,
				session,
				server,
				appId: app.appId,
				files: layerFiles(app.appId, layer),
				reached: reachedInstances(states, app.appId, layer)
			});
		});
	}
}

/**
 * The distinct servers a shared layer has to reach: every bound server for
 * `all`, the preview binding's for `preview`.
 */
export function serversFor(workspaceRootDir: string, layer: 'all' | 'preview'): string[] {
	const bindings = readBindings(workspaceRootDir);
	const servers = Object.entries(bindings)
		.filter(([key]) => layer === 'all' || key === PREVIEW_SCOPE)
		.map(([, binding]) => binding.server);
	return [...new Set(servers)];
}

/**
 * The scopes this project can name, for a prompt and for the `list` matrix:
 * local, the two shared layers, and every bound target.
 */
export function knownScopes(workspaceRootDir: string): string[] {
	const bindings = readBindings(workspaceRootDir);
	const targets = Object.keys(bindings)
		.filter((key) => key !== PREVIEW_SCOPE)
		.map((key) => (key === PROD_ENV ? PRODUCTION_TARGET : key));
	return ['local', ALL_SCOPE, PREVIEW_SCOPE, ...targets];
}

async function promptScope(workspaceRootDir: string, label: string): Promise<EnvScope> {
	const scopes = knownScopes(workspaceRootDir);
	if (!isInteractive()) {
		throw new TargetError(
			`${label} needs ${pc.cyan('-t')} to say which environment: ${scopes.join(', ')}.`
		);
	}
	const hints: Record<string, string> = {
		local: '.env on this machine',
		[ALL_SCOPE]: 'every deployed target, on every server',
		[PREVIEW_SCOPE]: 'every preview'
	};
	const choice = await p.select({
		message: 'Which environment?',
		options: scopes.map((scope) => ({ value: scope, label: scope, hint: hints[scope] }))
	});
	if (p.isCancel(choice)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return parseEnvScope(choice)!;
}

/** Whether a project can only see a key's new value after a deploy. */
export function readAtBuildTime(workspaceRootDir: string, keys: string[]): string[] {
	const names = staticEnvImports(workspaceRootDir);
	return keys.filter((key) => names.has(key));
}

/**
 * Make a change to a shared layer take effect: restart every instance it
 * reaches on this server, with the same exception as a single target —
 * superuser credentials wait for a deploy to reconcile the database.
 */
export async function applyLayerRestart(ctx: LayerContext, changed: string[]): Promise<void> {
	if (touchesSuperuser(changed)) {
		p.log.warn(
			`PocketBase superuser credentials changed.\n\n` +
				`Each database still holds the old ones, so nothing was restarted.\n` +
				`Run ${pc.cyan('vela deploy')} for every target to push them in.`
		);
		return;
	}
	if (ctx.reached.length === 0) {
		p.log.info(`Nothing of this app runs on ${ctx.server} yet; the value applies on first deploy.`);
		return;
	}
	for (const state of ctx.reached) {
		const outcome = await restartInstance(ctx.session, state.instance);
		if (!outcome.deployed) continue;
		if (outcome.restarted) p.log.success(`${state.env} restarted ${pc.dim(`(${ctx.server})`)}`);
		else {
			p.log.error(
				`${state.env} restart failed.\n\n` +
					`The new value is stored and will be used the next time it starts.\n` +
					`${pc.dim(outcome.error ?? '')}`
			);
		}
	}
}

/**
 * Report that a change took effect, or why it has not yet: a key the app reads
 * at build time only changes on the next deploy, so "restarted" would mislead.
 */
export async function applyChange(
	workspaceRootDir: string,
	ctx: InstanceEnvContext | LayerContext,
	changed: string[]
): Promise<void> {
	const baked = readAtBuildTime(workspaceRootDir, changed);
	if (baked.length > 0) {
		p.log.info(
			`${baked.join(', ')} ${baked.length === 1 ? 'is' : 'are'} read at build time (${pc.cyan('$env/static')}); ` +
				`redeploy to apply.`
		);
		const rest = changed.filter((key) => !baked.includes(key));
		if (rest.length === 0) return;
		changed = rest;
	}
	if (ctx.kind === 'layer') await applyLayerRestart(ctx, changed);
	else await applyEnvRestart(ctx, changed);
}

/** The instance id a scope prompt option resolves to on a server, for `list`. */
export function instanceFor(workspaceRootDir: string, envTag: string): string | null {
	const app = readAppIdentity(workspaceRootDir);
	return app ? instanceId(app.appId, envTag) : null;
}
