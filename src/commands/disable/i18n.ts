import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const i18n = new Command('i18n')
	.description('disable internationalization')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-i18n',
						confirmMessage:
							'Disable i18n? Removes i18n scaffolding files and the Wuchale .gitignore block. Manual reverts are still required in vite.config, svelte.config, hooks.server, app.html, and +layout.ts.',
						report: {
							summary: 'Disabled i18n scaffolding.',
							nextSteps: [
								'Manually revert the Wuchale wiring in vite.config, svelte.config, hooks.server, app.html, and +layout.ts.'
							],
							task: {
								title: 'Disabling i18n',
								success: 'Disabled i18n',
								error: 'Failed to disable i18n'
							}
						}
					},
					opts,
					cmd.args
				),
			'Failed to disable i18n.'
		)
	);
