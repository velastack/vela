import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { addTargetOptions, withServerSession, withTarget } from '../lib/server-command.ts';
import { readInstanceStates, type InstanceState } from '../lib/remote.ts';

export const status = addTargetOptions(
	new Command('status').description('show what is deployed').configureHelp(helpConfig),
	'production'
)
	.option('--all', 'show every app on the server, not just this project')
	.option('--json', 'print raw JSON')
	.action((raw: unknown) =>
		runCommand(async () => {
			const options = raw as { all?: boolean; json?: boolean };

			// `--all` is a question about the machine, so it needs a server but not
			// an instance — and `--server` alone answers it outside a project.
			if (options.all) {
				await withServerSession(raw, async (session) => {
					report(await readInstanceStates(session), options.json);
				});
				return;
			}

			await withTarget(
				raw,
				{
					remote: async (ctx) => {
						report(await readInstanceStates(ctx.session, ctx.instance), options.json);
					}
				},
				{
					label: 'status',
					localHint: 'Nothing is deployed locally — `vela dev` reports what it is running.'
				}
			);
		}, 'Failed to read status.')
	);

function report(states: InstanceState[], json?: boolean): void {
	if (json) {
		console.log(JSON.stringify(states, null, 2));
		return;
	}
	if (states.length === 0) {
		p.log.info('Nothing is deployed here yet.');
		return;
	}
	for (const state of states) {
		p.log.info(describe(state));
	}
}

function describe(state: InstanceState): string {
	const health = (value?: string) =>
		value === 'active' ? pc.green(value) : pc.red(value || 'inactive');
	const rows: [string, string][] = [
		['Instance', state.instance],
		['Environment', state.env],
		['Release', state.activeRelease ?? '—'],
		['Previous', state.previousRelease || '—'],
		['Domain', state.domain || '—'],
		['Ports', `web ${state.webPort ?? '?'}${state.backend ? `, pb ${state.pbPort ?? '?'}` : ''}`],
		['App', health(state.services?.web)],
		...(state.backend
			? ([['PocketBase', health(state.services?.pocketbase)]] as [string, string][])
			: []),
		['Deployed', state.deployedAt ?? '—'],
		...(state.rolledBackAt ? ([['Rolled back', state.rolledBackAt]] as [string, string][]) : []),
		...(state.gitSha ? ([['Commit', state.gitSha.slice(0, 12)]] as [string, string][]) : [])
	];
	const width = Math.max(...rows.map(([label]) => label.length));
	return (
		pc.cyan(state.name) +
		'\n\n' +
		rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n')
	);
}
