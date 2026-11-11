import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const og = new Command('og')
	.description('enable generated Open Graph images (a share card for every page)')
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-og',
					cmd.args,
					{},
					{
						summary: 'Enabled Open Graph images.',
						nextSteps: [
							'Design the card in `src/lib/og/card.svelte`; it is plain markup and CSS.',
							'Open `/og/index.png` to see the home page card, or `/og/<path>.png` for any other page.',
							'Set `url` in `src/lib/site.ts` to the deployed address: the image URL in the meta tags is built from it.'
						],
						task: {
							title: 'Enabling Open Graph images',
							success: 'Enabled Open Graph images',
							error: 'Failed to enable Open Graph images'
						}
					}
				),
			'Failed to enable Open Graph images.'
		)
	);
