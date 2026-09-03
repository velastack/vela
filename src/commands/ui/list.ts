import { Command } from 'commander';
import * as p from '@clack/prompts';
import { listComponents } from '@velastack/patterns';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { uiListReport } from '../../lib/ui-list.ts';

export const list = new Command('list')
	.description('list installed ui components, vela components and the style registry')
	.option('--json', 'print the result as JSON', false)
	.configureHelp(helpConfig)
	.action((options: { json: boolean }) =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();

			if (options.json) {
				const result = await listComponents({ root: workspaceRootDir });
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			const spinner = p.spinner();
			spinner.start('Reading the registry...');
			let result;
			try {
				result = await listComponents({ root: workspaceRootDir });
			} catch (e) {
				spinner.stop('Could not list UI components');
				throw e;
			}
			spinner.stop(`Read the ${result.style} registry`);

			reportResult(uiListReport(result));
			if (result.registryUnavailable) {
				p.log.warn(`${result.registryUnavailable}\nRegistry components are not listed.`);
			}
		}, 'Failed to list UI components.')
	);
