import { Command } from 'commander';
import * as p from '@clack/prompts';
import { applyBaseColor } from '@velastack/patterns';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { BASE_COLORS } from '../../lib/ui-add.ts';

export const base = new Command('base')
	.description('change the base (gray) palette')
	.argument('<color>', `base color to use (${BASE_COLORS.join(', ')})`)
	.configureHelp(helpConfig)
	.action((color: string) =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();

			// The palette is what `shadcn-svelte apply --only theme` produces for
			// the project's own style, so the tokens never need hand-maintenance.
			// The accepted colors come from the installed shadcn-svelte.
			const log = p.taskLog({ title: `Applying the ${color} palette...` });
			let outcome;
			try {
				outcome = await applyBaseColor({ root: workspaceRootDir, color });
				log.success('Palette applied');
			} catch (e) {
				log.error('Could not change the base color');
				throw e;
			}

			reportResult({
				summary: `Set base color to ${outcome.baseColor}.`,
				filesModified: outcome.filesModified,
				nextSteps: [
					'Run your dev server to preview the new palette.',
					'Run `vela ui theme <accent>` to put an accent color on top of it.',
					'Tweak individual CSS variables in src/app.css if you want to customize the theme further.'
				]
			});
		}, 'Failed to change base color.')
	);
