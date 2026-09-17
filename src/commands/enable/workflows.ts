import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const workflows = new Command('workflows')
	.description('add background workflows to a project created before they were built in')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-workflows',
					cmd.args,
					{},
					{
						summary: 'Enabled workflows.',
						nextSteps: [
							'Run `vela generate workflow <name>` to add one to src/lib/workflows/.',
							'Start a run from server code with `<name>.run(input)`; runs show up under Workflows in the PocketBase dashboard.',
							'Read src/lib/workflows/README.md for recurring workflows, retries and the worker settings.'
						],
						task: {
							title: 'Enabling workflows',
							success: 'Enabled workflows',
							error: 'Failed to enable workflows'
						}
					}
				),
			'Failed to enable workflows.'
		)
	);
