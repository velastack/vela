import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const workflow = new Command('workflow')
	.description('generate a background workflow in src/lib/workflows')
	.argument('<name>', 'workflow name, e.g. send-welcome-email')
	.option('--cron <schedule>', 'run on a schedule, e.g. "*/5 * * * *"')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((name: string, options: { cron?: string }, cmd) =>
		runCommand(
			() =>
				runPattern(
					'generate-workflow',
					[name, ...(options.cron ? ['--cron', options.cron] : []), ...cmd.args.slice(1)],
					{},
					{
						summary: `Generated the ${name} workflow.`,
						nextSteps: [
							'Fill in the steps in the new file under src/lib/workflows/.',
							options.cron
								? 'It starts on its schedule whenever the app is running; `.run()` starts an extra run.'
								: 'Start a run from server code with `.run(input)`; runs show up under Workflows in the PocketBase dashboard.',
							'Run `vela test:server` to run its test.'
						],
						task: {
							title: 'Generating workflow',
							success: 'Generated workflow',
							error: 'Failed to generate workflow'
						}
					}
				),
			'Failed to generate workflow.'
		)
	);
