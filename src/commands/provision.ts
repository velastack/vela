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
import {
	readInstanceStates,
	readServerInfo,
	runServerScript,
	syncServerScripts,
	type InstanceState
} from '../lib/remote.ts';
import { targetLabel } from './targets.ts';
import { sshOptionsFrom, SSH_OPTION_SCHEMA, addSshOptions } from '../lib/ssh-options.ts';

/**
 * The Node line servers are brought up to: the one releases are built with (the
 * action's default too), so the server's npm accepts the build's lockfile.
 */
const NODE_MAJOR = '26';

const OptionsSchema = v.object({
	...SSH_OPTION_SCHEMA,
	pbVersion: v.optional(v.string()),
	// A number: provision.sh compares it with the server's major, so a line
	// name like `lts` would never count as reached.
	nodeMajor: v.optional(
		v.pipe(v.string(), v.regex(/^\d+$/, 'must be a major version number, like 26'))
	),
	// commander's `--no-swap`: true unless the flag is given.
	swap: v.optional(v.boolean())
});

/** What provision.sh is run with. */
export function provisionArgs(
	options: { nodeMajor?: string; swap?: boolean },
	pbVersion: string
): string[] {
	return [
		'--pb-version',
		pbVersion,
		'--node-major',
		options.nodeMajor ?? NODE_MAJOR,
		'--cli-version',
		pkg.version,
		...(options.swap === false ? ['--no-swap'] : [])
	];
}

/** An instance as `status.sh` reports it. */
type HostedInstance = InstanceState & {
	/** Whether the live release has anything in node_modules. Absent from older scripts. */
	runtimeDependencies?: boolean;
};

/**
 * What to say once Node has moved to a new major: which apps on the server to
 * redeploy. Their dependencies were installed, and any native module compiled,
 * for the old one; a deploy installs afresh. An app with nothing installed has
 * nothing to redo and is left out. Undefined when the server hosts no apps.
 */
export function redeployNotice(
	states: HostedInstance[],
	fromMajor: string,
	node: string
): string | undefined {
	if (states.length === 0) return undefined;
	const due = states
		.filter((state) => state.runtimeDependencies !== false)
		.sort((a, b) => a.name.localeCompare(b.name) || a.env.localeCompare(b.env));
	const spared = states.length - due.length;
	const moved = `Node moved from ${fromMajor} to ${node.replace(/^v/, '')}.`;
	if (due.length === 0) {
		return `${moved} No app on this server has dependencies installed, so none needs a redeploy.`;
	}
	const rows = due.map((state) => [state.name, targetLabel(state.env), state.url ?? '']);
	const width = (column: number) => Math.max(...rows.map((row) => row[column]!.length));
	const [name, target] = [width(0), width(1)];
	return (
		`${moved} Redeploy ${due.length === 1 ? 'this app' : 'these apps'} now: ` +
		`${due.length === 1 ? 'its' : 'their'} dependencies were installed for Node ${fromMajor}.\n\n` +
		rows
			.map((row) => `  ${row[0]!.padEnd(name)}  ${row[1]!.padEnd(target)}  ${row[2]}`.trimEnd())
			.join('\n') +
		`\n\nRun \`vela deploy\` in each app's own project, with \`-t <target>\` for any target but production.` +
		(spared > 0
			? `\n${spared === 1 ? 'One other app has' : `${spared} other apps have`} nothing installed and can stay as ${spared === 1 ? 'it is' : 'they are'}.`
			: '')
	);
}

/** `Swap` in megabytes for the summary, or nothing when the server has none. */
function megabytes(value: string | undefined): string | undefined {
	return value && /^\d+$/.test(value) && value !== '0' ? `${value} MB` : undefined;
}

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
	.option(
		'--no-swap',
		'do not add a swapfile (one is added when the server has under 2 GB of memory and no swap)'
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
					memoryMb?: string;
					swapMb?: string;
					nodeUpgradedFrom?: string;
				}>(session, 'provision.sh', {
					args: provisionArgs(options, pbVersion),
					stream: true
				});

				const memory = megabytes(result?.memoryMb);
				const swap = megabytes(result?.swapMb);
				p.log.success(
					`${target} is ready.\n\n` +
						`  Node        ${result?.node ?? 'installed'}\n` +
						`  Caddy       ${result?.caddy ?? 'installed'}\n` +
						`  PocketBase  ${result?.pocketbase ?? pbVersion}` +
						(memory ? `\n  Memory      ${memory}${swap ? ` + ${swap} swap` : ', no swap'}` : '')
				);

				// Nothing is redeployed from here: each app builds from its own
				// repository, which this command knows nothing about.
				if (result?.nodeUpgradedFrom) {
					let states: HostedInstance[] = [];
					let listed = true;
					try {
						states = await readInstanceStates(session);
					} catch {
						listed = false;
						// Not being able to list them must not fail a provision that worked.
					}
					const notice = listed
						? redeployNotice(states, result.nodeUpgradedFrom, result.node)
						: `Node moved up from ${result.nodeUpgradedFrom}. Redeploy every app on this server now: their dependencies were installed for Node ${result.nodeUpgradedFrom}.`;
					if (notice) p.log.warn(notice);
				}
			});

			p.outro(`Deploy with ${pc.cyan(`vela deploy --server ${target}`)}`);
		}, 'Failed to provision.')
	);
