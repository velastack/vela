import { Command } from 'commander';
import * as p from '@clack/prompts';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { runPattern } from '../../lib/pattern-runner.ts';
import { assertShadcn } from '../../lib/require-ui.ts';
import { resolveFormInput } from '../../lib/form-ui.ts';
import { getWorkspace } from '../../lib/workspace.ts';
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
	.option('--remote', 'generate create/update forms with SvelteKit remote functions')
	.option(
		'--route <route>',
		'place the scaffold at a custom route (e.g. "(app)/[team_id]/projects"). Defaults to the pluralized model name under the (app) or (public) group, or src/routes when it has neither.'
	)
	.option(
		'--ui <ui>',
		'markup to generate: "shadcn" components or "plain" HTML. Defaults to shadcn when the project has shadcn-svelte, plain otherwise. --remote needs shadcn.'
	)
	.option(
		'--ai <description>',
		'design the scaffold with AI from a natural-language description (two stages: schema → layout)'
	)
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action(
		(
			model: string | undefined,
			fields: string[],
			options: { remote?: boolean; route?: string; ui?: string; ai?: string }
		) =>
			runCommand(async () => {
				// The remote scaffold has no plain variant. The pattern is refused the
				// same way, but only after the AI stages have been paid for and the
				// layout sidecar written.
				if (options.remote) {
					if (options.ui === 'plain') {
						throw new Error('--remote has no plain variant; drop --ui plain or --remote.');
					}
					assertShadcn('vela generate scaffold --remote');
				}

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

				const { workspaceRootDir, features } = await getWorkspace();
				const formInput = resolveFormInput(workspaceRootDir, features.ui, options.ui);
				if (features.ui === 'plain' && !options.ui) {
					p.log.info('shadcn-svelte not detected: generating plain HTML pages.');
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
					{ route: options.route, ...formInput },
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
