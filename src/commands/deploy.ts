import path from 'node:path';
import fs from 'node:fs';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import * as v from 'valibot';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { parseOptions } from '../lib/options.ts';
import { getWorkspace, hasBackend } from '../lib/workspace.ts';
import { withSsh, type SshSession } from '../lib/ssh.ts';
import { addSshOptions, SSH_OPTION_SCHEMA, sshOptionsFrom } from '../lib/ssh-options.ts';
import { loadDeployConfig, recordDeployment, resolveAppIdentity } from '../lib/deploy-config.ts';
import { instanceId, normalizeEnvTag, releaseId } from '../lib/instance.ts';
import { ensureSuperuser, pocketbaseVersion } from '../lib/pocketbase.ts';
import {
	readInstanceStates,
	remotePaths,
	requireProvisioned,
	runServerScript,
	syncServerScripts
} from '../lib/remote.ts';
import { collectArtifact, gitSha, runBuild } from '../lib/artifact.ts';
import { readRemoteEnv } from '../lib/remote-env.ts';

const OptionsSchema = v.object({
	...SSH_OPTION_SCHEMA,
	env: v.optional(v.string()),
	project: v.optional(v.string()),
	domain: v.optional(v.string()),
	healthPath: v.optional(v.string()),
	keep: v.optional(v.string()),
	pbVersion: v.optional(v.string()),
	build: v.optional(v.boolean())
});

export const deploy = addSshOptions(
	new Command('deploy')
		.description('deploy the app to a server')
		.argument('<target>', 'SSH target — an alias from ~/.ssh/config, or user@host')
		.configureHelp(helpConfig)
)
	.option('-e, --env <tag>', 'environment to deploy', 'prod')
	.option('--project <name>', 'override the project name')
	.option('--domain <hosts>', 'hostname(s) to serve on, comma separated')
	.option('--health-path <path>', 'path the health check requests')
	.option('--keep <count>', 'how many old releases to keep on the server')
	.option('--pb-version <version>', 'PocketBase version to run')
	.option('--no-build', 'deploy the existing build output without rebuilding')
	.action((target: string, raw: unknown) =>
		runCommand(async () => {
			const options = parseOptions(OptionsSchema, raw);
			const { workspaceRootDir } = await getWorkspace();
			const config = await loadDeployConfig(workspaceRootDir);
			const app = resolveAppIdentity(workspaceRootDir, {
				...config,
				project: options.project ?? config.project
			});

			const envTag = normalizeEnvTag(options.env);
			const instance = instanceId(app.appId, envTag);
			const backend = hasBackend(workspaceRootDir);
			const release = releaseId();

			p.intro(pc.bgCyan(pc.black(' vela deploy ')));
			p.log.info(`${pc.cyan(app.name)} ${pc.dim('→')} ${pc.cyan(target)} ${pc.dim(`(${envTag})`)}`);

			if (options.build !== false) {
				p.log.step('Building');
				// The build renders pages against a local database, and on a fresh
				// checkout that database has no superuser yet. Done here as well as in
				// `vela build` so a project still pinning an older CLI builds in CI.
				if (backend) await ensureSuperuser(workspaceRootDir);
				await runBuild(workspaceRootDir, config.deploy?.buildCommand);
			}

			const entries = collectArtifact(workspaceRootDir, config.deploy ?? {});
			const sha = await gitSha(workspaceRootDir);

			await withSsh(target, sshOptionsFrom(options), async (session) => {
				await session.detectElevation();
				await requireProvisioned(session);
				await syncServerScripts(session);

				const [existing] = await readInstanceStates(session, instance);
				const domain = options.domain ?? config.deploy?.domain ?? existing?.domain ?? '';

				p.log.step(`Uploading release ${pc.dim(release)}`);
				await uploadRelease(session, instance, release, entries);

				p.log.step('Activating');
				const result = await runServerScript<{
					url: string;
					webPort: number;
					pbPort: number;
				}>(session, 'apply.sh', {
					args: [
						instance,
						release,
						'--name',
						app.name,
						'--app-id',
						app.appId,
						'--env',
						envTag,
						'--domain',
						domain,
						'--health-path',
						options.healthPath ?? config.deploy?.healthCheckPath ?? '/',
						'--keep',
						options.keep ?? String(config.deploy?.keepReleases ?? 5),
						'--backend',
						backend ? '1' : '0',
						'--pb-version',
						options.pbVersion ?? config.deploy?.pocketbaseVersion ?? pocketbaseVersion(),
						'--git-sha',
						sha
					],
					stream: true
				});

				recordDeployment(workspaceRootDir, envTag, { target, domain: domain || undefined });
				if (!existing) await reportEmptyEnvironment(session, instance, workspaceRootDir);

				const url = result?.url ?? '';
				p.log.success(
					`Deployed ${pc.cyan(app.name)} ${pc.dim(release)}\n\n` +
						`  URL   ${url}\n` +
						`  Port  ${result?.webPort ?? '?'}${backend ? ` (PocketBase ${result?.pbPort ?? '?'})` : ''}`
				);

				if (!domain) {
					p.log.warn(
						`No domain configured, so nothing is proxied to this app yet.\n` +
							`Redeploy with ${pc.cyan('--domain example.com')} once DNS points at ${target}.`
					);
				}
			});

			p.outro(`${pc.cyan(`vela status ${target}`)} to see what is running`);
		}, 'Failed to deploy.')
	);

async function uploadRelease(
	session: SshSession,
	instance: string,
	release: string,
	entries: { localPath: string; remoteDir: string }[]
): Promise<void> {
	const dir = remotePaths.release(instance, release);
	await session.script(`mkdir -p "$1"`, { args: [dir] });

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
