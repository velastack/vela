import { Command } from 'commander';
import * as v from 'valibot';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { parseOptions } from '../../lib/options.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { readAppIdentity, readBindings } from '../../lib/deploy-config.ts';
import { SSH_OPTION_SCHEMA, sshOptionsFrom } from '../../lib/ssh-options.ts';
import { withSsh } from '../../lib/ssh.ts';
import { readInstanceStates, requireProvisioned } from '../../lib/remote.ts';
import { readLocalEnv } from '../../lib/local-env.ts';
import { addEnvTargetOptions, parseEnvScope, withEnvScope } from '../../lib/env-command.ts';
import {
	layerFiles,
	readLayer,
	resolveStack,
	type Layer,
	type LayerContents
} from '../../lib/env-scopes.ts';

const OptionsSchema = v.object({
	...SSH_OPTION_SCHEMA,
	target: v.optional(v.string()),
	server: v.optional(v.string())
});

const HIDDEN = '••••';
const MAX_VALUE = 32;

/**
 * Which keys exist where. Public values are shown; a secret shows as `••••`,
 * on every side, so the output is safe to paste wherever it came from.
 */
export const envList = addEnvTargetOptions(
	new Command('list')
		.description('list environment variables — every scope at once without -t')
		.configureHelp(helpConfig)
).action((raw: unknown) =>
	runCommand(async () => {
		const options = parseOptions(OptionsSchema, raw);
		if (!parseEnvScope(options.target)) {
			await listMatrix(raw);
			return;
		}

		await withEnvScope(
			raw,
			{
				// Names only: `.env` is one file with no public side, and a value typed
				// there is the developer's own.
				local: async (ctx) => {
					const keys = Object.keys(readLocalEnv(ctx.envFile)).sort();
					if (keys.length === 0) {
						p.log.info(`No environment variables configured ${pc.dim('(local)')}.`);
						return;
					}
					p.log.info(
						`Environment ${pc.dim('(local, .env)')}\n\n${keys.map((k) => `  ${k}`).join('\n')}`
					);
				},
				instance: async (ctx) => {
					const stack = await resolveStack(ctx.session, ctx.appId, ctx.instance, ctx.preview);
					const keys = Object.keys(stack.entries).sort();
					if (keys.length === 0) {
						p.log.info(`No environment variables configured ${pc.dim(`(${ctx.targetName})`)}.`);
						return;
					}
					const width = Math.max(...keys.map((k) => k.length));
					p.log.info(
						`Environment ${pc.dim(`(${ctx.targetName}, as the app sees it)`)}\n\n` +
							keys
								.map((key) => {
									const entry = stack.entries[key]!;
									const from = entry.layer === 'instance' ? '' : pc.dim(`  from ${entry.layer}`);
									return `  ${key.padEnd(width)}  ${cell(entry.visibility, entry.value)}${from}`;
								})
								.join('\n')
					);
				},
				layer: async (ctx) => {
					const contents = await readLayer(ctx.session, ctx.files);
					const keys = [...Object.keys(contents.secret), ...Object.keys(contents.public)].sort();
					const where = `${ctx.layer}, ${ctx.server}`;
					if (keys.length === 0) {
						p.log.info(`No environment variables configured ${pc.dim(`(${where})`)}.`);
						return;
					}
					const width = Math.max(...keys.map((k) => k.length));
					p.log.info(
						`Environment ${pc.dim(`(${where})`)}\n\n` +
							keys
								.map(
									(key) =>
										`  ${key.padEnd(width)}  ${key in contents.public ? cell('public', contents.public[key]) : cell('secret')}`
								)
								.join('\n')
					);
				}
			},
			{ label: 'env list' }
		);
	}, 'Failed to read the environment.')
);

function cell(visibility: 'public' | 'secret', value?: string): string {
	if (visibility === 'secret') return pc.dim(HIDDEN);
	const shown = value ?? '';
	return shown.length > MAX_VALUE ? `${shown.slice(0, MAX_VALUE - 1)}…` : shown;
}

interface Column {
	heading: string;
	layer: Layer;
	contents: LayerContents;
}

/**
 * Every scope on every bound server, one table per server: the shared layers
 * first, then each target there. An instance column shows what it sets itself
 * and names the layer anything else comes from, so the table reads the way
 * systemd resolves it.
 */
async function listMatrix(raw: unknown): Promise<void> {
	const options = parseOptions(OptionsSchema, raw);
	const { workspaceRootDir } = await getWorkspace();
	const app = readAppIdentity(workspaceRootDir);
	const bindings = readBindings(workspaceRootDir);

	const local = Object.keys(readLocalEnv(`${workspaceRootDir}/.env`)).sort();
	p.log.info(
		local.length
			? `Local ${pc.dim('(.env, names only)')}\n\n${local.map((k) => `  ${k}`).join('\n')}`
			: `No local environment ${pc.dim('(.env)')}.`
	);

	const servers = [...new Set(Object.values(bindings).map((b) => b.server))];
	if (!app || servers.length === 0) {
		p.log.info(`No target is bound to a server yet; ${pc.cyan('vela deploy')} binds one.`);
		return;
	}

	for (const server of servers) {
		await withSsh(server, sshOptionsFrom(options), async (session) => {
			await session.detectElevation();
			await requireProvisioned(session);
			const states = (await readInstanceStates(session)).filter((s) => s.appId === app.appId);
			const hasPreview = states.some((s) => s.preview) || bindings.preview?.server === server;

			const columns: Column[] = [
				{
					heading: 'all',
					layer: 'all',
					contents: await readLayer(session, layerFiles(app.appId, 'all'))
				}
			];
			if (hasPreview) {
				columns.push({
					heading: 'preview',
					layer: 'preview',
					contents: await readLayer(session, layerFiles(app.appId, 'preview'))
				});
			}
			for (const state of states) {
				columns.push({
					heading: state.preview ? `preview:${state.env}` : state.env,
					layer: 'instance',
					contents: await readLayer(session, layerFiles(app.appId, 'instance', state.instance))
				});
			}

			const keys = [
				...new Set(
					columns.flatMap((c) => [
						...Object.keys(c.contents.secret),
						...Object.keys(c.contents.public)
					])
				)
			].sort();
			if (keys.length === 0) {
				p.log.info(`No environment variables configured ${pc.dim(`(${server})`)}.`);
				return;
			}

			const rows = keys.map((key) => [
				key,
				...columns.map((c, i) => matrixCell(key, columns, i, states))
			]);
			const headings = ['', ...columns.map((c) => c.heading)];
			const widths = headings.map((h, i) =>
				Math.max(h.length, ...rows.map((r) => plain(r[i]!).length))
			);
			const line = (cells: string[]) =>
				cells.map((c, i) => c + ' '.repeat(widths[i]! - plain(c).length)).join('  ');
			p.log.info(
				`Environment ${pc.dim(`(${server})`)}\n\n` +
					`  ${pc.dim(line(headings))}\n` +
					rows.map((r) => `  ${line(r)}`).join('\n')
			);
		});
	}
}

/**
 * One cell: what this column sets, or — for an instance column — the layer
 * its value would come from, so inheritance is visible without a second table.
 */
function matrixCell(
	key: string,
	columns: Column[],
	index: number,
	states: { instance: string; preview?: boolean }[]
): string {
	const column = columns[index]!;
	if (key in column.contents.public) return cell('public', column.contents.public[key]);
	if (key in column.contents.secret) return cell('secret');
	if (column.layer !== 'instance') return pc.dim('—');

	// Walk the shared layers this instance resolves, highest first.
	const state = states[index - columns.findIndex((c) => c.layer === 'instance')];
	const inherits = columns.filter(
		(c) => c.layer === 'all' || (c.layer === 'preview' && state?.preview === true)
	);
	for (const layer of inherits.reverse()) {
		if (key in layer.contents.public || key in layer.contents.secret) {
			return pc.dim(`↑ ${layer.heading}`);
		}
	}
	return pc.dim('—');
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
function plain(text: string): string {
	return text.replace(ANSI, '');
}
