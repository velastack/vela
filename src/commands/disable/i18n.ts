import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand, runDisable } from './_shared.ts';

export const i18n = new Command('i18n')
	.description('disable internationalization')
	.option('-y, --yes', 'skip confirmation prompt')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((opts, cmd) =>
		runCommand(
			() =>
				runDisable(
					{
						slug: 'disable-i18n',
						confirmMessage:
							'Disable i18n? Deletes the Wuchale config, reroute hook, URL helpers and language select, uninstalls wuchale, and reverts vite.config, svelte.config, hooks.server, app.html, the root +layout.ts and layout, and .gitignore. The translation catalogs in src/locales stay.',
						report: {
							summary: 'Disabled i18n.',
							nextSteps: ['Delete src/locales if you no longer need the translation catalogs.'],
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
