import { Command } from 'commander';
import * as p from '@clack/prompts';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { runSchemaStage, specToArgv } from '../../lib/ai-flow.ts';

export const schema = new Command('schema')
	.description('generate a schema from a model')
	.argument('[model]', 'model name')
	.argument('[fields...]', 'field definitions')
	.option('--ai <description>', 'design the schema with AI from a natural-language description')
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action((model: string | undefined, fields: string[], options: { ai?: string }) =>
		runCommand(async () => {
			let argv: string[];
			let modelName: string;

			if (options.ai) {
				if (model) {
					throw new Error('Pass either a model name or --ai, not both.');
				}
				const stage = await runSchemaStage({ prompt: options.ai, useCase: 'schema' });
				if (!stage) {
					p.cancel('Aborted before any files were written.');
					return;
				}
				argv = specToArgv(stage.model);
				modelName = stage.model.name;
			} else {
				if (!model) {
					throw new Error('Missing required argument: model. Pass a model name or use --ai.');
				}
				argv = [model, ...fields];
				modelName = model;
			}

			await runPattern(
				'generate-schema',
				argv,
				{},
				{
					summary: `Created ${modelName} schema.`,
					nextSteps: [
						`Edit field types and validation in src/lib/schemas/${modelName}.ts.`,
						`Run \`vela generate form ${modelName}\` to add a form for this schema.`
					],
					task: {
						title: 'Generating schema',
						success: 'Generated schema',
						error: 'Failed to generate schema'
					}
				}
			);
		}, 'Failed to generate schema.')
	);
