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

export const scaffold = new Command('scaffold')
	.description('generate a full CRUD scaffold (model, forms, list, detail)')
	.argument('[model]', 'model name')
	.argument('[fields...]', 'field definitions')
	.option('--remote', 'generate a scaffold backed by a remote PocketBase collection')
	.option(
		'--route <route>',
		'place the scaffold at a custom route (e.g. "(app)/[team_id]/projects"). Defaults to the pluralized model name under (app)/(public).'
	)
	.option(
		'--ai <description>',
		'design the scaffold with AI from a natural-language description (two stages: schema → layout)'
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
					const stage = await runSchemaStage({ prompt: options.ai, useCase: 'scaffold' });
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

				const slug = options.remote ? 'generate-scaffold-remote' : 'generate-scaffold';
				const nextSteps: string[] = [
					`Run \`vela fixtures generate\` to create 10 ${modelName} records for development.`,
					'Run `vela dev` and visit the generated route to use the scaffold.',
					'Tweak list columns and detail layout in the generated +page.svelte files.'
				];
				if (sidecarPath) {
					nextSteps.unshift(
						`Apply the AI-designed form layout from ${sidecarPath} to the generated new/edit +page.svelte files.`
					);
				}

				await runPattern(
					slug,
					argv,
					{ route: options.route },
					{
						summary: `Created ${modelName} scaffold.`,
						nextSteps,
						task: {
							title: 'Generating scaffold',
							success: 'Generated scaffold',
							error: 'Failed to generate scaffold'
						}
					}
				);
			}, 'Failed to generate scaffold.')
	);
