import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { getWorkspace } from './../lib/workspace.ts';
import { loadDeployConfig, readAppIdentity, readBindings } from '../lib/deploy-config.ts';
import { instanceId } from '../lib/instance.ts';
import { addSshOptions, sshOptionsFrom, SSH_OPTION_SCHEMA } from '../lib/ssh-options.ts';
import { parseOptions } from '../lib/options.ts';
import { withSsh } from '../lib/ssh.ts';
import { readInstanceStates } from '../lib/remote.ts';
import { getPocketbaseMetadata } from '../lib/pocketbase.ts';
import * as v from 'valibot';

const OptionsSchema = v.object({
	...SSH_OPTION_SCHEMA,
	json: v.optional(v.boolean()),
	offline: v.optional(v.boolean())
});

interface Row {
	target: string;
	kind: 'local' | 'remote';
	server: string;
	domain: string;
	release: string;
	reachable: boolean;
}

export const targets = addSshOptions(
	new Command('targets')
		.description('list the targets this project can deploy to')
		.configureHelp(helpConfig)
)
	.option('--json', 'print raw JSON')
	.option('--offline', 'skip connecting to servers')
	.action((raw: unknown) =>
		runCommand(async () => {
			const options = parseOptions(OptionsSchema, raw);
			const { workspaceRootDir } = await getWorkspace();
			const config = await loadDeployConfig(workspaceRootDir);
			// Listing must never mint an app id — that is a side effect nobody asks
			// for by running `vela targets`.
			const app = readAppIdentity(workspaceRootDir, config);
			const bindings = readBindings(workspaceRootDir);

			const metadata = getPocketbaseMetadata(workspaceRootDir);
			const rows: Row[] = [
				{
					target: 'local',
					kind: 'local',
					server: '—',
					domain: metadata ? `http://${metadata.viteHost}:${metadata.vitePort}` : '—',
					release: '—',
					reachable: true
				}
			];

			// One connection per machine, not per target: a server usually hosts
			// several of this project's targets, and asking it once is enough.
			const byServer = new Map<string, string[]>();
			for (const [envTag, binding] of Object.entries(bindings)) {
				byServer.set(binding.server, [...(byServer.get(binding.server) ?? []), envTag]);
			}

			for (const [server, envTags] of byServer) {
				let states: Awaited<ReturnType<typeof readInstanceStates>> = [];
				let reachable = false;

				if (!options.offline && app) {
					try {
						await withSsh(server, sshOptionsFrom(options), async (session) => {
							await session.detectElevation();
							states = await readInstanceStates(session);
						});
						reachable = true;
					} catch {
						// One unreachable box must not empty the whole table.
					}
				}

				for (const envTag of envTags) {
					const binding = bindings[envTag]!;
					const instance = app ? instanceId(app.appId, envTag) : '';
					const state = states.find((candidate) => candidate.instance === instance);
					rows.push({
						target: envTag,
						kind: 'remote',
						server,
						domain: state?.domain || binding.domain || '—',
						release: state?.activeRelease ?? (reachable ? 'not deployed' : '—'),
						reachable
					});
				}
			}

			if (options.json) {
				console.log(JSON.stringify(rows, null, 2));
				return;
			}

			report(rows, options.offline === true);
		}, 'Failed to list targets.')
	);

function report(rows: Row[], offline: boolean): void {
	// The header is part of the column, or a short value leaves it hanging over
	// the rows beneath it.
	const width = (heading: string, pick: (row: Row) => string) =>
		Math.max(heading.length, ...rows.map((row) => pick(row).length));
	const target = width('TARGET', (row) => row.target);
	const server = width('SERVER', (row) => row.server);
	const domain = width('DOMAIN', (row) => row.domain);

	const header = `${'TARGET'.padEnd(target)}  ${'SERVER'.padEnd(server)}  ${'DOMAIN'.padEnd(domain)}  RELEASE`;
	const lines = rows.map(
		(row) =>
			`${row.kind === 'local' ? pc.dim(row.target.padEnd(target)) : pc.cyan(row.target.padEnd(target))}  ` +
			`${row.server.padEnd(server)}  ${row.domain.padEnd(domain)}  ${row.release}`
	);

	p.log.info(`${pc.dim(header)}\n${lines.join('\n')}`);

	const unreachable = rows.filter((row) => row.kind === 'remote' && !row.reachable);
	if (!offline && unreachable.length > 0) {
		p.log.warn(
			`Could not reach ${unreachable.map((row) => row.server).join(', ')}.\n` +
				`Release and domain are shown from what this project recorded.`
		);
	}
}
