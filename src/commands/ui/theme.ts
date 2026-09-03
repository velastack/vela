import { Command } from 'commander';
import * as p from '@clack/prompts';
import { applyTheme } from '@velastack/patterns';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { THEMES } from '../../lib/ui-add.ts';

export const theme = new Command('theme')
	.description('change the accent color, keeping the base palette')
	.argument('<accent>', `accent to use (${THEMES.join(', ')})`)
	.configureHelp(helpConfig)
	.action((accent: string) =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();

			const log = p.taskLog({ title: `Applying the ${accent} accent...` });
			let outcome;
			try {
				outcome = await applyTheme({ root: workspaceRootDir, theme: accent });
				log.success('Accent applied');
			} catch (e) {
				log.error('Could not change the accent');
				throw e;
			}

			reportResult({
				summary: `Set accent to ${outcome.theme} on the ${outcome.baseColor} palette.`,
				filesModified: outcome.filesModified,
				nextSteps: [
					'Run your dev server to preview the new accent.',
					'Run `vela ui base <color>` to change the palette underneath (this resets the accent).',
					'Tweak individual CSS variables in src/app.css if you want to customize the theme further.'
				]
			});
		}, 'Failed to change accent.')
	);
