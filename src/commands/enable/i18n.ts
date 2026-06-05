import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const i18n = new Command('i18n')
	.description('enable internationalization')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-i18n',
					cmd.args,
					{},
					{
						summary: 'Enabled internationalization.',
						nextSteps: [
							'Add or adjust locales in wuchale.config.js.',
							'Run `vela i18n extract` to pull translatable strings from your components.',
							'Edit the generated .po files under locales/ to add translations.'
						],
						task: {
							title: 'Enabling i18n',
							success: 'Enabled i18n',
							error: 'Failed to enable i18n'
						}
					}
				),
			'Failed to enable i18n.'
		)
	);
