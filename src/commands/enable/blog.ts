import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const blog = new Command('blog')
	.description('enable an mdsvex blog with posts, tags, and RSS')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((_opts, cmd) =>
		runCommand(
			() =>
				runPattern(
					'enable-blog',
					cmd.args,
					{},
					{
						summary: 'Enabled blog.',
						nextSteps: [
							'Run `vela dev` and visit /blog to see the example posts.',
							'Add new posts as .svx files in src/lib/content/blog/.',
							'Customize the post layout in src/routes/(public)/blog/[slug]/+page.svelte.'
						],
						task: {
							title: 'Enabling blog',
							success: 'Enabled blog',
							error: 'Failed to enable blog'
						}
					}
				),
			'Failed to enable blog.'
		)
	);
