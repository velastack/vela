import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { hasBackend } from '../../lib/workspace.ts';

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
			// The command is exempt from the PocketBase guard — the CMS keeps its own
			// database — but the backend it installs runs inside the app's server,
			// which a static project does not have. A hosted CMS installs no backend,
			// so with --endpoint a static site is fine.
			if (!opts.endpoint && !hasBackend()) {
				p.log.error(
					`${pc.cyan('vela enable cms')} needs a server to host the CMS backend, and this project is static.\n\n` +
						`Run ${pc.cyan('vela bless')} to add a backend, or point at a hosted CMS with ${pc.cyan('vela enable cms --endpoint <url>')}.`
				);
				p.log.message();
				p.cancel('Operation failed.');
				process.exitCode = 1;
				return;
			}

			await runPattern('enable-cms', cmd.args, opts.endpoint ? { endpoint: opts.endpoint } : {}, {
				summary: 'Enabled CMS.',
				nextSteps: [
					opts.endpoint
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
