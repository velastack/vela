import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';

export const resource = new Command('resource')
	.description('generate a resource (model + CRUD pages)')
	.argument('<model>', 'model name')
	.argument('[fields...]', 'field definitions')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((model: string, fields: string[]) =>
		runCommand(
			() =>
				runPattern(
					'generate-resource',
					[model, ...fields],
					{},
					{
						summary: `Created ${model} resource.`,
						nextSteps: [
							`Run \`vela fixtures generate\` to create some ${model} records for development.`,
							`Run \`vela dev\` and visit /${model} to see the CRUD pages.`,
							`Customize the UI in src/routes/${model}/+page.svelte.`
						],
						task: {
							title: 'Generating resource',
							success: 'Generated resource',
							error: 'Failed to generate resource'
						}
					}
				),
			'Failed to generate resource.'
		)
	);
