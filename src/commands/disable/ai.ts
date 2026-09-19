import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const ai = new Command('ai')
	.description('disable AI chat')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-ai',
						confirmMessage:
							"Disable AI? Deletes src/lib/server/ai.ts, the /api/chat endpoint and the /ai demo page, removes the provider's API key from .env and uninstalls the AI SDK packages.",
						report: {
							summary: 'Disabled AI.',
							nextSteps: [
								'Remove the API key from each deploy target with `vela env unset` if you set one there.'
							],
							task: {
								title: 'Disabling AI',
								success: 'Disabled AI',
								error: 'Failed to disable AI'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable AI.'
		)
	);
