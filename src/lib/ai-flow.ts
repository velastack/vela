import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { aiSchema, aiForm, type CollectionSpec, type FormLayout } from './ai-client.ts';
import { aiLoop } from './ai-loop.ts';
import { loadExistingModels } from './ai-existing-models.ts';
import { collectionSpecToArgv } from './ai-to-argv.ts';
import { renderGrid } from './ai-grid.ts';
import { getWorkspace } from './workspace.ts';

export type AiUseCase = 'scaffold' | 'form' | 'schema';

const USE_CASE_HINT: Record<AiUseCase, string> = {
	scaffold:
		'Use case: scaffold — designing a new persisted PocketBase collection. Lean toward forward-thinking field choices.',
	form:
		'Use case: form — designing fields for a Svelte form with no DB persistence. Focus on user-input fields; relations only to existing collections.',
	schema:
		'Use case: schema — designing a standalone zod schema. Same considerations as form.'
};

function renderModel(spec: CollectionSpec): void {
	const lines: string[] = [];
	lines.push(`${pc.bold(spec.name)} (${spec.type})`);
	const nameWidth = Math.max(...spec.fields.map((f) => f.name.length), 4);
	const typeWidth = Math.max(...spec.fields.map((f) => f.type.length), 4);
	for (const f of spec.fields) {
		const required = f.required ? pc.yellow('!') : ' ';
		const extra: string[] = [];
		if (f.values && f.values.length > 0) extra.push(`values=[${f.values.join(',')}]`);
		if (f.collectionName) extra.push(`→ ${f.collectionName}`);
		const tail = extra.length > 0 ? '  ' + pc.dim(extra.join(' ')) : '';
		lines.push(`  ${f.name.padEnd(nameWidth)}  ${f.type.padEnd(typeWidth)} ${required}${tail}`);
	}
	p.log.message(lines.join('\n'));
}

function renderLayout(layout: FormLayout): void {
	p.log.message(renderGrid(layout));
}

export interface RunSchemaStageOptions {
	prompt: string;
	useCase: AiUseCase;
}

export interface RunSchemaStageResult {
	model: CollectionSpec;
	workspaceRootDir: string;
}

export async function runSchemaStage(opts: RunSchemaStageOptions): Promise<RunSchemaStageResult | null> {
	const { workspaceRootDir } = await getWorkspace();
	const existingModels = await loadExistingModels(workspaceRootDir);

	const initialPrompt = `${USE_CASE_HINT[opts.useCase]}\n\nDescribe and design a model for: ${opts.prompt}`;

	const model = await aiLoop<CollectionSpec>({
		initialPrompt,
		stageLabel: 'Designing schema',
		refinePlaceholder: 'e.g. "make role required and add a hire_date field"',
		call: ({ prompt, history }) =>
			aiSchema(workspaceRootDir, {
				prompt,
				history,
				context: { existingModels }
			}),
		renderPreview: renderModel
	});

	if (!model) return null;
	return { model, workspaceRootDir };
}

export async function runLayoutStage(
	workspaceRootDir: string,
	model: CollectionSpec
): Promise<FormLayout | null> {
	return aiLoop<FormLayout>({
		initialPrompt: '',
		stageLabel: 'Designing layout',
		refinePlaceholder: 'e.g. "single column on mobile" or "group address fields"',
		call: ({ prompt, history }) =>
			aiForm(workspaceRootDir, {
				prompt: prompt || undefined,
				history,
				context: { model }
			}),
		renderPreview: renderLayout
	});
}

export function specToArgv(spec: CollectionSpec): string[] {
	return collectionSpecToArgv(spec);
}

/**
 * Persist the chosen layout as a sidecar file at
 * `data/ai-form-layouts/<model>.json`. Returns the relative path.
 */
export function writeLayoutSidecar(
	workspaceRootDir: string,
	modelName: string,
	layout: FormLayout
): string {
	const dir = path.join(workspaceRootDir, 'data', 'ai-form-layouts');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${modelName}.json`);
	fs.writeFileSync(file, JSON.stringify(layout, null, 2) + '\n');
	return path.relative(workspaceRootDir, file);
}
