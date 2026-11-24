import { Command } from 'commander';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { rulesOption, type Rules } from '../../lib/rules-option.ts';

export const resource = new Command('resource')
	.description('generate a resource (collection, migration and zod schema; no pages)')
	.argument('<model>', 'model name')
	.argument('[fields...]', 'field definitions')
	.addOption(rulesOption())
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action((model: string, fields: string[], options: { rules?: Rules }) =>
		runCommand(
			() =>
				runPattern(
					'generate-resource',
					[model, ...fields],
					{ rules: options.rules },
					{
						summary: `Created ${model} resource.`,
						nextSteps: [
							`Run \`vela fixtures generate\` to create some ${model} records for development.`,
							`Edit field types and validation in src/lib/schemas/${model}.ts.`,
							`A resource has no pages. Run \`vela generate scaffold ${model}\` with the same fields to add list, detail and form pages.`
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
