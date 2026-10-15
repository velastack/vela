import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import * as v from 'valibot';
import pkg from '../../package.json' with { type: 'json' };
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { parseOptions } from '../lib/options.ts';
import { withSsh } from '../lib/ssh.ts';
import { pocketbaseVersion } from '../lib/pocketbase.ts';
import { readServerInfo, runServerScript, syncServerScripts } from '../lib/remote.ts';
import { sshOptionsFrom, SSH_OPTION_SCHEMA, addSshOptions } from '../lib/ssh-options.ts';

/**
 * The Node line servers are brought up to: the one releases are built with (the
 * action's default too), so the server's npm accepts the build's lockfile.
 */
const NODE_MAJOR = '24';

const OptionsSchema = v.object({
	...SSH_OPTION_SCHEMA,
	pbVersion: v.optional(v.string()),
	// A number: provision.sh compares it with the server's major, so a line
	// name like `lts` would never count as reached.
	nodeMajor: v.optional(
		v.pipe(v.string(), v.regex(/^\d+$/, 'must be a major version number, like 24'))
	)
});

export const provision = addSshOptions(
	new Command('provision')
		.description('prepare a server to host vela apps')
		.argument('<target>', 'SSH target — an alias from ~/.ssh/config, or user@host')
		.configureHelp(helpConfig)
)
	.option('--pb-version <version>', 'PocketBase version to install')
	// A server already on a later major keeps it (see provision.sh).
	.option(
		'--node-major <version>',
		'Node.js major version to bring the server up to (match the one you build with)',
		NODE_MAJOR
	)
	.action((target: string, raw: unknown) =>
		runCommand(async () => {
			const options = parseOptions(OptionsSchema, raw);
			const pbVersion = options.pbVersion ?? pocketbaseVersion();

			p.intro(pc.bgCyan(pc.black(' vela provision ')));
			p.log.info(`Target ${pc.cyan(target)}`);

			await withSsh(target, sshOptionsFrom(options), async (session) => {
				await session.detectElevation();

				const existing = await readServerInfo(session);
				if (existing) {
					p.log.info(
						`Already provisioned by vela ${existing.cliVersion} on ${existing.provisionedAt}. Bringing it up to date.`
					);
				}

				p.log.step('Uploading server scripts');
				await syncServerScripts(session);

				p.log.step('Running provision');
				const result = await runServerScript<{
					node: string;
					caddy: string;
					pocketbase: string;
				}>(session, 'provision.sh', {
					args: [
						'--pb-version',
						pbVersion,
						'--node-major',
						options.nodeMajor ?? NODE_MAJOR,
						'--cli-version',
						pkg.version
					],
					stream: true
				});

				p.log.success(
					`${target} is ready.\n\n` +
						`  Node        ${result?.node ?? 'installed'}\n` +
						`  Caddy       ${result?.caddy ?? 'installed'}\n` +
						`  PocketBase  ${result?.pocketbase ?? pbVersion}`
				);
			});

			p.outro(`Deploy with ${pc.cyan(`vela deploy --server ${target}`)}`);
		}, 'Failed to provision.')
	);
