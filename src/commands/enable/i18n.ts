import * as p from '@clack/prompts';
import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import {
	describeOutcome,
	loadUrlPatternPlan,
	promptUrlPatterns,
	writeUrlPatterns
} from '../../lib/i18n-routes.ts';
import { isInteractive } from '../../lib/providers.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { findWorkspaceRoot } from '../../lib/workspace.ts';

const ROUTES_STEP =
	'Run `vela i18n routes` to choose which pages have a URL in every language. Until a page is listed in `url.patterns`, links to it stay in the default language and it is a 404 under a locale prefix.';

/**
 * Ask which of the project's pages exist in every locale, once the config is
 * on disk. Returns whether that is settled; when it is not (no terminal, a
 * cancelled prompt, a config that could not be edited) the next steps name
 * the command that asks again. Enabling i18n never fails over this.
 */
async function chooseLocalizedRoutes(): Promise<boolean> {
	if (!isInteractive()) return false;
	try {
		const root = findWorkspaceRoot();
		const loaded = root ? loadUrlPatternPlan(root) : null;
		if (!loaded || 'error' in loaded) return false;
		const { configPath, plan } = loaded;
		if (plan.choices.every((choice) => choice.listed)) return true;

		const selected = await promptUrlPatterns(plan);
		if (selected === null) return false;
		const outcome = writeUrlPatterns(configPath, plan, selected);
		if (outcome.status === 'failed') return false;
		if (outcome.status === 'written') p.log.success(describeOutcome(configPath, outcome));
		return true;
	} catch {
		return false;
	}
}

export const i18n = new Command('i18n')
	.description('enable internationalization')
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) => {
		const nextSteps = [
			'Add or adjust locales in wuchale.config.js.',
			'Run `vela i18n extract` to pull translatable strings from your components.',
			'Edit the generated .po files under src/locales/ to add translations.'
		];
		return runCommand(
			() =>
				runPattern(
					'enable-i18n',
					cmd.args,
					{},
					{
						summary: 'Enabled internationalization.',
						nextSteps,
						task: {
							title: 'Enabling i18n',
							success: 'Enabled i18n',
							error: 'Failed to enable i18n'
						}
					},
					async () => {
						if (await chooseLocalizedRoutes()) {
							nextSteps.push('Run `vela i18n routes` again when you add a page.');
						} else {
							nextSteps.unshift(ROUTES_STEP);
						}
					}
				),
			'Failed to enable i18n.'
		);
	});
