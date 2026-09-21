import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { detectAdapter, type AdapterKind } from '../../lib/adapter.ts';
import { cmsEndpointFor } from '../../lib/link-on-create.ts';
import { readProjectConfig } from '../../lib/project-config.ts';
import { findWorkspaceRoot, hasBackend } from '../../lib/workspace.ts';

export type CmsBackend =
	| { kind: 'hosted'; endpoint: string; from: 'flag' | 'link' }
	| { kind: 'self-hosted' }
	| { kind: 'none' };

/**
 * Where the CMS backend runs.
 *
 * The self-hosted one is SQLite inside the app's own server, so what it needs
 * is a Node server: a PocketBase backend implies one, and so does
 * adapter-node on its own, which is what a project vela did not create has
 * after `vela deploy`. adapter-auto is not counted — it decides per platform,
 * and most of what it picks has no disk to keep a database on.
 *
 * Without a server, a project linked to velastack.dev has a hosted CMS there,
 * so `vela link && vela enable cms` needs no URL. `--endpoint` always wins.
 */
export function resolveCmsBackend(facts: {
	endpoint?: string;
	backend: boolean;
	adapter: AdapterKind;
	projectId?: string;
}): CmsBackend {
	if (facts.endpoint) return { kind: 'hosted', endpoint: facts.endpoint, from: 'flag' };
	if (facts.backend || facts.adapter === 'node') return { kind: 'self-hosted' };
	if (facts.projectId) {
		return { kind: 'hosted', endpoint: cmsEndpointFor(facts.projectId), from: 'link' };
	}
	return { kind: 'none' };
}

function adapterOf(root: string): AdapterKind {
	try {
		return detectAdapter(root).kind;
	} catch {
		// An unreadable config is not a reason to refuse a project with a backend.
		return 'none';
	}
}

export const cms = new Command('cms')
	.description('enable an inline-editing CMS with an admin bar')
	.option(
		'--endpoint <url>',
		'read from a hosted CMS at this URL instead of installing the backend in this app'
	)
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts: { endpoint?: string }, cmd) =>
		runCommand(async () => {
			const root = findWorkspaceRoot() ?? process.cwd();
			const backend = resolveCmsBackend({
				endpoint: opts.endpoint,
				backend: hasBackend(root),
				adapter: adapterOf(root),
				projectId: readProjectConfig(root)?.projectId
			});

			if (backend.kind === 'none') {
				p.log.error(
					`${pc.cyan('vela enable cms')} needs somewhere to run the CMS backend, and this project has no Node server.\n\n` +
						`Any one of these gives it one:\n` +
						`  - ${pc.cyan('vela link')}, then run this again: the linked project's hosted CMS is used.\n` +
						`  - ${pc.cyan('vela enable cms --endpoint <url>')} to point at a hosted CMS yourself.\n` +
						`  - ${pc.cyan('vela enable backend')}, or switching to @sveltejs/adapter-node, to host it in this app.`
				);
				p.log.message();
				p.cancel('Operation failed.');
				process.exitCode = 1;
				return;
			}

			const hosted = backend.kind === 'hosted';
			if (hosted && backend.from === 'link') {
				p.log.info(`Using the hosted CMS of the linked project (${pc.cyan(backend.endpoint)}).`);
			}

			// `server` tells the pattern what was just worked out: without it, it only
			// takes a PocketBase backend as proof of a server.
			const input = hosted ? { endpoint: backend.endpoint } : { server: true };
			await runPattern('enable-cms', cmd.args, input, {
				summary: 'Enabled CMS.',
				nextSteps: [
					hosted
						? 'Editors are managed where the CMS is hosted, not with `vela cms editor`.'
						: 'Run `vela cms editor add you@example.com` to create the first editor login.',
					'Run `vela dev`, open any page with `?edit` on the URL, and sign in from the admin bar.',
					'Wrap page copy in `<CmsText>` and images in `<CmsImage>` to make them editable.'
				],
				task: {
					title: 'Enabling CMS',
					success: 'Enabled CMS',
					error: 'Failed to enable CMS'
				}
			});
		}, 'Failed to enable CMS.')
	);
