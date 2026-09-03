import { Command } from 'commander';
import * as p from '@clack/prompts';
import { installComponents, type InstallComponentsResult } from '@velastack/patterns';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { uiAddReport } from '../../lib/ui-add.ts';

export const add = new Command('add')
	.description('add ui components (shadcn-svelte items and vela components such as data-table)')
	.argument('<components...>', 'the components to add')
	.option('--overwrite', 'replace components that already exist', false)
	.configureHelp(helpConfig)
	.action((components: string[], options: { overwrite: boolean }) =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();

			// One installer for patterns and this command: vela's own components
			// (data-table, multiselect, ...) are copied in, everything else goes to
			// `shadcn-svelte add`, and the dependencies of both are resolved.
			const log = p.taskLog({ title: 'Adding UI components...' });
			let outcome: InstallComponentsResult;
			try {
				outcome = await installComponents({
					root: workspaceRootDir,
					components,
					overwrite: options.overwrite,
					logger: { info: (message: string) => log.message(message) }
				});
				log.success('UI components ready');
			} catch (e) {
				log.error('Could not add UI components');
				throw e;
			}

			reportResult(uiAddReport(components, outcome));
		}, 'Failed to add UI components.')
	);
