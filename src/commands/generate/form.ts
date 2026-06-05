import { Command } from 'commander';
import * as p from '@clack/prompts';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import {
	runSchemaStage,
	runLayoutStage,
	specToArgv,
	writeLayoutSidecar
} from '../../lib/ai-flow.ts';

export const form = new Command('form')
	.description('generate a form from a model')
	.argument('[model]', 'model name (e.g. "contact")')
	.argument('[fields...]', 'field definitions (e.g. "name:text", "email:email")')
	.option('--remote', 'generate a form backed by a remote PocketBase collection')
	.option(
		'--route <route>',
		'place the form at a custom route (e.g. "(app)/[team_id]/projects/new"). Defaults to the model name under (app)/(public).'
	)
	.option(
		'--ai <description>',
		'design the form with AI from a natural-language description (two stages: schema → layout)'
	)
	.allowUnknownOption(true)
	.configureHelp(helpConfig)
	.action(
		(
			model: string | undefined,
			fields: string[],
			options: { remote?: boolean; route?: string; ai?: string }
		) =>
			runCommand(async () => {
				let argv: string[];
				let modelName: string;
				let sidecarPath: string | null = null;

				if (options.ai) {
					if (model) {
						throw new Error('Pass either a model name or --ai, not both.');
					}
					const stage = await runSchemaStage({ prompt: options.ai, useCase: 'form' });
					if (!stage) {
						p.cancel('Aborted before any files were written.');
						return;
					}
					const layout = await runLayoutStage(stage.workspaceRootDir, stage.model);
					if (!layout) {
						p.cancel('Aborted before any files were written.');
						return;
					}
					argv = specToArgv(stage.model);
					modelName = stage.model.name;
					sidecarPath = writeLayoutSidecar(stage.workspaceRootDir, modelName, layout);
				} else {
					if (!model) {
						throw new Error('Missing required argument: model. Pass a model name or use --ai.');
					}
					argv = [model, ...fields];
					modelName = model;
				}

				const slug = options.remote ? 'generate-form-remote' : 'generate-form';
				const nextSteps: string[] = [
					'Edit the form fields and validation in the generated +page.svelte.',
					'Run `vela dev` to preview the form in the browser.'
				];
				if (sidecarPath) {
					nextSteps.unshift(
						`Apply the AI-designed form layout from ${sidecarPath} to the generated +page.svelte.`
					);
				}

				await runPattern(
					slug,
					argv,
					{ route: options.route },
					{
						summary: `Created ${modelName} form.`,
						nextSteps,
						task: {
							title: 'Generating form',
							success: 'Generated form',
							error: 'Failed to generate form'
						}
					}
				);
			}, 'Failed to generate form.')
	);
