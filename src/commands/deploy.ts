import path from 'node:path';
import fs from 'node:fs';
import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import * as v from 'valibot';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { parseOptions } from '../lib/options.ts';
import { getWorkspace, hasBackend } from '../lib/workspace.ts';
import { withSsh, type SshSession } from '../lib/ssh.ts';
import { addSshOptions, SSH_OPTION_SCHEMA, sshOptionsFrom } from '../lib/ssh-options.ts';
import { writeBinding } from '../lib/deploy-config.ts';
import { bindingKey } from '../lib/target.ts';
import {
	addLockWaitOption,
	addTargetOptions,
	LOCK_WAIT_SCHEMA,
	lockWaitArgs,
	withTarget
} from '../lib/server-command.ts';
import { instanceId, normalizeEnvTag, releaseId } from '../lib/instance.ts';
import { ensureSuperuser, findFreePort, pocketbaseVersion } from '../lib/pocketbase.ts';
import { readLocalMeta, readRemoteAppURL, seedRemoteMeta } from '../lib/pocketbase-settings.ts';
import { normalizeOrigin, splitHosts } from '../lib/origin.ts';
import { createDeployReporter } from '../lib/deploy-report.ts';
import { restartInstance } from '../lib/remote-env.ts';
import {
	instanceHasBackend,
	readInstanceStates,
	remotePaths,
	requireProvisioned,
	runServerScript,
	serverTime,
	syncServerScripts,
	type InstanceState
} from '../lib/remote.ts';
import { collectArtifact, gitSha, runBuild } from '../lib/artifact.ts';
import {
	ADAPTER_AUTO,
	ADAPTER_NODE,
	AdapterError,
	ensureNodeAdapter,
	installAdapterDependencies,
	lockfileFor
} from '../lib/adapter.ts';
import { readRemoteEnv } from '../lib/remote-env.ts';

const OptionsSchema = v.object({
	...SSH_OPTION_SCHEMA,
	env: v.optional(v.string()),
	project: v.optional(v.string()),
	...LOCK_WAIT_SCHEMA,
	remoteDb: v.optional(v.boolean()),
	domain: v.optional(v.string()),
	healthPath: v.optional(v.string()),
	keep: v.optional(v.string()),
	pbVersion: v.optional(v.string()),
	build: v.optional(v.boolean())
});

export const deploy = addLockWaitOption(
	addTargetOptions(
		new Command('deploy').description('deploy the app').configureHelp(helpConfig),
		'production'
	)
)
	.option('--project <name>', 'override the project name')
	.option('--domain <hosts>', 'hostname(s) to serve on, comma separated')
	.option('--health-path <path>', 'path the health check requests')
	.option('--keep <count>', 'how many old releases to keep on the server')
	.option('--pb-version <version>', 'PocketBase version to run')
	.option('--no-build', 'deploy the existing build output without rebuilding')
	// Both spellings, with no default, so "neither flag given" stays
	// distinguishable from an explicit choice: commander would otherwise make
	// `--no-remote-db` alone default the value to true.
	.addOption(
		new Option(
			'--remote-db',
			'render the build against the database on the server, over an SSH tunnel — on by default once the target has been deployed to with a backend'
		).default(undefined)
	)
	.addOption(
		new Option('--no-remote-db', 'render the build against a throwaway local database').default(
			undefined
		)
	)
	.action((raw: unknown) =>
		runCommand(async () => {
			const options = parseOptions(OptionsSchema, raw);
			const backend = hasBackend();

			p.intro(pc.bgCyan(pc.black(' vela deploy ')));

			// Local preflight, before a server is named or a deploy announced:
			// a project that cannot build for a server has nothing to deploy.
			if (options.build !== false) {
				const { workspaceRootDir } = await getWorkspace();
				await prepareAdapter(workspaceRootDir);
			}

			await withTarget(
				raw,
				{
					remote: async (ctx) => {
						const { session, instance, workspaceRootDir, config } = ctx;
						p.log.info(
							`${pc.cyan(ctx.appName)} ${pc.dim('→')} ${pc.cyan(ctx.targetName)} ${pc.dim(`(${ctx.server})`)}`
						);

						const [existing] = await readInstanceStates(session, instance);
						// Stamped from the server's clock, so a laptop and a CI runner
						// deploying the same instance agree on which release is newer;
						// apply.sh refuses one that would take the site backwards.
						const release = releaseId(await serverTimeOrLocal(session));
						const isPreview = ctx.target.kind === 'preview';
						// The binding outranks the config file: one `deploy.domain` cannot
						// serve production and staging at once. A preview inherits neither —
						// the binding is shared by every branch and `deploy.domain` is the
						// live site — only what its own instance already had.
						const configured =
							options.domain ??
							(isPreview
								? existing?.domain
								: (ctx.binding.domain ?? config.deploy?.domain ?? existing?.domain)) ??
							'';
						// Rendering against the database being deployed to is the default
						// once there is one to render against. Left off, a build quietly
						// used a throwaway local database instead, which is how prerendered
						// pages shipped with a developer's own data baked into them.
						const askedForRemoteDb = options.remoteDb ?? config.deploy?.buildAgainstRemote;
						const remoteDb = askedForRemoteDb ?? instanceHasBackend(existing);

						// The backend is detected from the project, not remembered: a
						// project blessed since its last deploy gains a PocketBase on this
						// one, and the server moves its data directory across. Worth a
						// line, because it is the deploy that changes what the instance is.
						if (existing && instanceHasBackend(existing) !== backend) {
							p.log.info(
								backend
									? `${pc.cyan(ctx.targetName)} was deployed without a backend before. This deploy adds PocketBase.`
									: `${pc.cyan(ctx.targetName)} was deployed with a backend before. This deploy removes PocketBase; its database stays on the server.`
							);
						}

						// Announce the deploy before building. The answer carries the
						// hostnames velastack.dev has for this environment — including a
						// managed velastack.app one once the server is registered — and the
						// build renders its absolute URLs against the primary one.
						const sha = await gitSha(workspaceRootDir);
						const reporter = createDeployReporter(workspaceRootDir);
						const server = await reporter.identifyServer(session);
						const started = await reporter.start({
							target: ctx.target.kind === 'preview' ? 'preview' : ctx.targetName,
							env_tag: ctx.envTag,
							branch: ctx.target.kind === 'preview' ? ctx.target.branch : undefined,
							git_sha: sha || undefined,
							hostnames: splitHosts(configured),
							server: server ? { id: server.serverId, token: server.token } : undefined
						});
						// Hosts Caddy serves directly: what is configured here plus any
						// velastack.dev has recorded for the environment. Managed
						// `<sub>.velastack.app` names arrive through the Worker at the
						// server's origin site instead, and are routed by header.
						const directHosts = [
							...new Set([...splitHosts(configured), ...(started?.environment.direct ?? [])])
						];
						const managedHosts = started?.environment.managed ?? [];
						const domain = directHosts.join(',');
						const managed = managedHosts.join(',');
						const primaryHost = directHosts[0] ?? managedHosts[0] ?? '';
						const primaryUrl =
							started?.environment.primaryUrl || normalizeOrigin(primaryHost) || '';

						let result: {
							url: string;
							webPort: number;
							pbPort: number;
							superuserCreated: boolean;
						} | null = null;

						try {
							// Production without a domain is a warning at the end; a preview
							// nobody can reach is not worth building. Inside the try so the
							// deploy just announced is closed out as failed, not left open.
							if (isPreview && !primaryHost) {
								throw new Error(
									`Nothing routes to this preview.\n\n` +
										`Previews get a free velastack.app hostname from velastack.dev: ${pc.cyan('vela link')} the\n` +
										`project and ${pc.cyan('vela login')} (or set ${pc.cyan('VELA_API_KEY')}). Or pass ${pc.cyan('--domain <host>')}\n` +
										`with DNS of your own pointing at ${ctx.server}.`
								);
							}

							if (options.build !== false) {
								// Prerendering has no request to take an origin from, and the
								// binding is not written until further down, so a first deploy
								// learns its domain from here or not at all.
								const origin = normalizeOrigin(process.env.VELA_ORIGIN ?? primaryUrl);
								let buildEnv: Record<string, string | undefined> = origin
									? { VELA_ORIGIN: origin }
									: {};
								let tunnel: Tunnel | null = null;

								if (backend && remoteDb) {
									try {
										tunnel = await openDatabaseTunnel(session, instance, existing);
									} catch (err) {
										// Asked for explicitly, the failure is the answer. Merely
										// defaulted on, it is only a reason to build the older way.
										if (askedForRemoteDb) throw err;
										p.log.warn(
											`Could not build against the ${pc.cyan(ctx.targetName)} database, ` +
												`using a local one instead.\n${pc.dim(String(err))}`
										);
									}
								}

								if (tunnel) {
									buildEnv = { ...buildEnv, ...tunnel.env };
									p.log.info(
										`Building against the ${pc.cyan(ctx.targetName)} database on ${ctx.server} ${pc.dim(`(port ${tunnel.pbPort})`)}`
									);
								} else if (backend) {
									// The build renders pages against a local database, and on a fresh
									// checkout that database has no superuser yet. Done here as well as
									// in `vela build` so a project pinning an older CLI builds in CI.
									await ensureSuperuser(workspaceRootDir);
								}

								p.log.step('Building');
								try {
									await runBuild(workspaceRootDir, config.deploy?.buildCommand, buildEnv);
								} finally {
									if (tunnel) await tunnel.close();
								}
							}

							const entries = collectArtifact(workspaceRootDir, config.deploy ?? {});

							p.log.step(`Uploading release ${pc.dim(release)}`);
							await uploadRelease(session, instance, release, entries);

							p.log.step('Activating');
							result = await runServerScript<{
								url: string;
								webPort: number;
								pbPort: number;
								superuserCreated: boolean;
							}>(session, 'apply.sh', {
								args: [
									instance,
									release,
									'--name',
									ctx.appName,
									'--app-id',
									ctx.appId,
									'--env',
									ctx.envTag,
									'--domain',
									domain,
									'--managed',
									managed,
									'--health-path',
									options.healthPath ?? config.deploy?.healthCheckPath ?? '/',
									'--keep',
									options.keep ?? String(config.deploy?.keepReleases ?? 5),
									'--backend',
									backend ? '1' : '0',
									'--pb-version',
									options.pbVersion ?? config.deploy?.pocketbaseVersion ?? pocketbaseVersion(),
									'--git-sha',
									sha,
									...lockWaitArgs(options.lockWait)
								],
								stream: true
							});
						} catch (err) {
							// The server has rolled back (or never activated); say so before
							// the error reaches the user.
							await reporter.finish({
								status: 'failed',
								error: err instanceof Error ? err.message : String(err)
							});
							throw err;
						}

						writeBinding(
							workspaceRootDir,
							bindingKey(ctx.target),
							isPreview
								? { server: ctx.server }
								: { server: ctx.server, domain: domain || undefined }
						);
						if (!existing) await reportEmptyEnvironment(session, instance, workspaceRootDir);

						const url = result?.url ?? '';
						await reporter.finish({
							status: 'deployed',
							release,
							// Without a host the server answers with a loopback URL, which
							// is nothing to link to from a dashboard.
							url: primaryHost ? url : undefined
						});

						const redirects = started?.environment.redirects ?? [];
						p.log.success(
							`Deployed ${pc.cyan(ctx.appName)} ${pc.dim(release)}\n\n` +
								`  URL   ${url}\n` +
								(redirects.length
									? `  Also  ${redirects.map((h) => `https://${h}`).join(', ')} ${pc.dim('(redirects here)')}\n`
									: '') +
								`  Port  ${result?.webPort ?? '?'}${backend ? ` (PocketBase ${result?.pbPort ?? '?'})` : ''}`
						);

						// A managed hostname is one KV write away from live, but the edge
						// takes up to a minute to see a new key.
						if (managed && managed !== existing?.managed) {
							p.log.info(`${pc.cyan(managed)} goes live within a minute.`);
						}

						// Created by the server on the first deploy of a backend instance, and
						// never printed: the app reads it from the environment, and a human who
						// wants the admin UI sets their own with `vela env set`.
						if (result?.superuserCreated) {
							await copyLocalBranding(
								session,
								instance,
								workspaceRootDir,
								primaryHost ? (result?.url ?? '') : ''
							);
							p.log.info(
								`Created the PocketBase superuser this app authenticates as.\n\n` +
									`Its credentials are stored in the environment on the server. To use\n` +
									`your own instead, ${pc.cyan('vela env set POCKETBASE_SUPERUSER_PASSWORD')}\n` +
									`and deploy again.`
							);
						} else if (backend && primaryHost) {
							await reportAppURLDrift(session, instance, primaryHost);
						}

						if (!primaryHost) {
							p.log.warn(
								`No domain configured, so nothing is proxied to this app yet.\n` +
									`Redeploy with ${pc.cyan('--domain example.com')} once DNS points at ${ctx.server}` +
									(reporter.enabled
										? ''
										: `,\nor ${pc.cyan('vela link')} it to get a free velastack.app hostname.`) +
									`.`
							);
						}
					}
				},
				{ project: options.project, askDomain: true, label: 'deploy' }
			);

			p.outro(`${pc.cyan('vela status')} to see what is running`);
		}, 'Failed to deploy.')
	);

/**
 * Get the project onto @sveltejs/adapter-node, and say what that took.
 *
 * `sv create` ships adapter-auto, which builds nothing on a server of your own;
 * the deploy would otherwise fail after the build with no build/index.js. The switch is ordinary source - a rewritten config line and
 * a devDependency - so it is made here and the user is asked to commit it. A
 * project on adapter-static or a hosted platform's adapter has decided
 * otherwise, and that decision is reported, not overridden.
 */
async function prepareAdapter(workspaceRootDir: string): Promise<void> {
	const rethrow = (err: unknown): never => {
		if (err instanceof AdapterError) {
			throw new Error(err.snippet ? `${err.message}\n\n${pc.cyan(err.snippet)}` : err.message);
		}
		throw err;
	};

	const outcome = await ensureNodeAdapter(workspaceRootDir, { install: false }).catch(rethrow);
	if (!outcome.configFile && !outcome.packageJsonChanged) return;

	const changed = [
		outcome.configFile,
		outcome.packageJsonChanged ? 'package.json' : undefined
	].filter((f): f is string => Boolean(f));
	const why =
		outcome.previous === 'auto'
			? `${ADAPTER_AUTO} builds nothing for a server of your own`
			: outcome.previous === 'none'
				? 'No adapter was configured'
				: `${ADAPTER_NODE} was configured but not in package.json`;

	p.log.step(`Switching the adapter to ${pc.cyan(ADAPTER_NODE)}`);
	p.log.info(
		`${why}, and vela deploy runs the app as a Node server.\n\n` +
			`  Changed  ${changed.join(', ')}` +
			(outcome.removedDeps.length ? `\n  Removed  ${outcome.removedDeps.join(', ')}` : '')
	);

	if (outcome.packageJsonChanged) {
		try {
			changed.push(lockfileFor(await installAdapterDependencies(workspaceRootDir)));
		} catch (err) {
			rethrow(err);
		}
	}
	p.log.warn(`Commit ${changed.join(', ')} so every deploy builds the same way.`);
}

/**
 * Point out an `appURL` that no longer matches the domain being deployed to.
 *
 * `appURL` is seeded once and belongs to the deployed admin panel from then on,
 * which is deliberate — it is how an app serves one canonical domain while being
 * deployed to another. That also makes it the one setting that can quietly go
 * stale after a domain change, taking password-reset emails and every other link
 * PocketBase renders with it. Reported rather than corrected, so the override
 * keeps working.
 */
async function reportAppURLDrift(
	session: SshSession,
	instance: string,
	domain: string
): Promise<void> {
	const expected = normalizeOrigin(domain);
	if (!expected) return;

	const current = await readRemoteAppURL(session, instance);
	if (!current || normalizeOrigin(current) === expected) return;

	p.log.warn(
		`This app's PocketBase ${pc.cyan('appURL')} is ${pc.dim(current)}, but it is served on ${pc.dim(expected)}.\n\n` +
			`Emails and anything else PocketBase links to will use the former. Update it in\n` +
			`the admin panel if that is not deliberate.`
	);
}

/**
 * Give a database this deploy created the branding the project already has.
 *
 * A fresh PocketBase answers with its own defaults, which is how a new
 * deployment ends up calling itself "Acme" on every page that reads
 * `locals.meta`. Best-effort by design: the deploy has already succeeded, so
 * nothing here is worth failing it over.
 */
async function copyLocalBranding(
	session: SshSession,
	instance: string,
	workspaceRootDir: string,
	appURL: string
): Promise<void> {
	const local = await readLocalMeta(workspaceRootDir);
	if (!local) return;

	try {
		const copied = await seedRemoteMeta(session, instance, local, appURL);
		if (copied.length === 0) return;

		// The app caches `meta` in process, and it read the defaults on the way up
		// a moment ago. Without this the site serves PocketBase's "Acme" until
		// something else happens to restart it.
		const outcome = await restartInstance(session, instance);
		if (outcome.deployed && !outcome.restarted) {
			p.log.warn(
				`Copied ${copied.join(', ')}, but the app did not restart to pick them up.\n` +
					`${pc.dim(outcome.error ?? '')}`
			);
			return;
		}
		p.log.success(`Copied ${copied.join(', ')} from this project's database`);
	} catch (err) {
		p.log.warn(
			`Could not copy this project's PocketBase settings across.\n` +
				`Set them in the admin panel instead. ${pc.dim(String(err))}`
		);
	}
}

interface Tunnel {
	env: Record<string, string>;
	pbPort: number;
	close: () => Promise<void>;
}

/**
 * Point the build at the target's PocketBase through the SSH connection that is
 * already open.
 *
 * Pages that prerender from data are rendered at build time, so whatever
 * database the build can see is what gets baked into the static HTML. On a CI
 * runner that is an empty throwaway database, which silently produces pages
 * full of defaults. Building against the instance being deployed to is what a
 * developer's own machine approximates, and what makes CI output match.
 *
 * The superuser credentials come off the server itself, so nothing new has to be
 * stored in CI. The build should only ever read; a load function that writes
 * would write to the live database.
 */
async function openDatabaseTunnel(
	session: SshSession,
	instance: string,
	state: InstanceState | undefined
): Promise<Tunnel> {
	const pbPort = instanceHasBackend(state) ? state?.pbPort : undefined;
	if (!pbPort) {
		throw new Error(
			`--remote-db needs a deployed database to build against, and ${instance} ${state ? 'has no backend' : 'has not been deployed yet'}.\n\n` +
				`Deploy once without it, then turn it on.`
		);
	}

	const remoteEnv = await readRemoteEnv(session, instance);
	const email = remoteEnv.POCKETBASE_SUPERUSER_EMAIL;
	const password = remoteEnv.POCKETBASE_SUPERUSER_PASSWORD;
	if (!email || !password) {
		// Failing here beats failing thirty seconds later, inside the build, as an
		// "invalid login credentials" stack trace from the app's own hooks.
		throw new Error(
			`--remote-db renders the build as the superuser of ${instance}, and that environment has no credentials for one.\n\n` +
				`Set them with \`vela env set POCKETBASE_SUPERUSER_EMAIL\` and \`vela env set POCKETBASE_SUPERUSER_PASSWORD\`.`
		);
	}

	const localPort = await findFreePort('127.0.0.1');
	await session.forwardLocalPort(localPort, '127.0.0.1', pbPort);

	// Having credentials is not the same as having ones the database accepts, and
	// the difference is invisible until the build is already running: the app
	// renders every page as an unauthenticated 500, and the deploy dies as
	// `[500] GET /` with nothing naming the cause.
	//
	// The two drift whenever the superuser password is changed in the admin panel,
	// because `$ETC/env` is what a deploy reconciles the database against, and
	// that reconciliation happens in `apply.sh` — after this build. So the first
	// deploy after such a change cannot repair itself; it fails here instead, and
	// this is where it has to be explained.
	if (!(await superuserAuthenticates(localPort, email, password))) {
		await session.cancelForward(localPort, '127.0.0.1', pbPort);
		throw new Error(
			`${instance} does not accept the superuser credentials in its own environment.\n\n` +
				`They are what \`--remote-db\` renders the build as. The usual cause is a password\n` +
				`changed in the PocketBase admin panel, which leaves the database and\n` +
				`${pc.cyan(`/etc/vela/apps/${instance}/env`)} disagreeing.\n\n` +
				`Point the environment at the password the database has:\n` +
				`  ${pc.cyan('vela env set POCKETBASE_SUPERUSER_PASSWORD')}\n\n` +
				`or build against a throwaway local database instead:\n` +
				`  ${pc.cyan('vela deploy --no-remote-db')}`
		);
	}

	return {
		pbPort,
		env: {
			POCKETBASE_URL: `http://127.0.0.1:${localPort}`,
			POCKETBASE_SUPERUSER_EMAIL: email,
			POCKETBASE_SUPERUSER_PASSWORD: password
		},
		close: () => session.cancelForward(localPort, '127.0.0.1', pbPort)
	};
}

/**
 * Whether the instance's own superuser credentials sign in to its database.
 *
 * A plain request rather than a PocketBase client: this runs before the build,
 * and all it needs to know is whether the password is the one on record.
 */
async function superuserAuthenticates(
	port: number,
	identity: string,
	password: string
): Promise<boolean> {
	try {
		const response = await fetch(
			`http://127.0.0.1:${port}/api/collections/_superusers/auth-with-password`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ identity, password })
			}
		);
		return response.ok;
	} catch {
		// Unreachable is not the same as unauthorized, and the tunnel has its own
		// failure modes. Let the build proceed and report whatever it finds.
		return true;
	}
}

async function uploadRelease(
	session: SshSession,
	instance: string,
	release: string,
	entries: { localPath: string; remoteDir: string }[]
): Promise<void> {
	const dir = remotePaths.release(instance, release);
	// The release directory itself is made without -p: an id already on the
	// server belongs to another deploy, and two uploads into one directory
	// would leave a release that is neither.
	await session.script(`mkdir -p "$(dirname "$1")" && mkdir "$1"`, { args: [dir] });

	const byTarget = new Map<string, string[]>();
	for (const entry of entries) {
		const target = entry.remoteDir ? `${dir}/${entry.remoteDir}` : dir;
		// A trailing slash makes rsync copy a directory's contents rather than the
		// directory itself, which is what a renamed target (data/hooks -> hooks)
		// needs.
		const source =
			entry.remoteDir && isDirectory(entry.localPath) ? `${entry.localPath}/` : entry.localPath;
		byTarget.set(target, [...(byTarget.get(target) ?? []), source]);
	}

	for (const [target, sources] of byTarget) {
		if (target !== dir) await session.script(`mkdir -p "$1"`, { args: [target] });
		await session.upload(sources, target);
	}
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/**
 * A brand new instance starts with an empty production environment. Say so once,
 * rather than quietly shipping an app that cannot reach anything — but never
 * upload the local `.env`, which is a development file.
 */
async function reportEmptyEnvironment(
	session: SshSession,
	instance: string,
	workspaceRootDir: string
): Promise<void> {
	const remote = await readRemoteEnv(session, instance);
	if (Object.keys(remote).length > 0) return;
	if (!fs.existsSync(path.join(workspaceRootDir, '.env'))) return;

	p.log.warn(
		`This app has no production environment variables yet.\n\n` +
			`Local ${pc.cyan('.env')} values are not uploaded by a deploy. Set them with\n` +
			`${pc.cyan('vela env set KEY')}, or copy a file across with ${pc.cyan('vela env import .env.production')}.`
	);
}

/** The server's clock, or this machine's with a warning when it cannot be read. */
async function serverTimeOrLocal(session: SshSession): Promise<Date> {
	try {
		return await serverTime(session);
	} catch {
		p.log.warn('Could not read the clock on the server; stamping this release from this machine.');
		return new Date();
	}
}
