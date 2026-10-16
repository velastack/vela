import { API_URL } from './constants.ts';
import { readApiKey, requireApiKey } from './config.ts';
import { readProjectConfig } from './project-config.ts';

export interface AiTurn {
	role: 'user' | 'assistant';
	content: string;
}

export interface CollectionFieldSpec {
	name: string;
	type: string;
	required?: boolean;
	values?: string[];
	collectionName?: string;
	maxSelect?: number;
	min?: number;
	max?: number;
}

export interface CollectionSpec {
	name: string;
	type: string;
	fields: CollectionFieldSpec[];
}

export interface FormLayoutCol {
	span: 1 | 2 | 3 | 4 | 6 | 12;
	field: string;
}

export interface FormLayoutRow {
	cols: FormLayoutCol[];
}

export interface FormLayout {
	rows: FormLayoutRow[];
}

export interface AiResult<T> {
	result: T;
	turn: AiTurn[];
}

interface AiSchemaRequest {
	prompt: string;
	history?: AiTurn[];
	context?: { existingModels?: CollectionSpec[] };
}

interface AiFormRequest {
	prompt?: string;
	history?: AiTurn[];
	context: { model: CollectionSpec };
}

export interface AiSchemaEditRequest {
	prompt: string;
	schema: unknown;
	history?: AiTurn[];
}

export interface AiSchemaEditResponse {
	schema: unknown;
	summary: string;
	turn: AiTurn[];
}

async function aiPost<T>(
	workspaceRootDir: string,
	endpoint: 'schema' | 'form' | 'schema-edit',
	body: AiSchemaRequest | AiFormRequest | AiSchemaEditRequest
): Promise<T> {
	const apiKey = requireApiKey();
	const project = readProjectConfig(workspaceRootDir);
	if (!project) {
		throw new Error(
			"This isn't a velastack project (no .vela/project.json). Run `vela create` first."
		);
	}

	const res = await fetch(`${API_URL}/v1/projects/${project.projectId}/ai/${endpoint}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`
		},
		body: JSON.stringify(body)
	});

	if (res.status === 401 || res.status === 403) {
		throw new Error('API key invalid — run `vela login`');
	}
	if (res.status === 502) {
		const msg = await res.text().catch(() => '');
		throw new Error(`AI request failed: ${msg || 'upstream error'}`);
	}
	if (!res.ok) {
		const msg = await res.text().catch(() => '');
		throw new Error(`Velastack API error (${res.status}): ${msg || res.statusText}`);
	}
	return (await res.json()) as T;
}

export const aiSchema = (workspaceRootDir: string, body: AiSchemaRequest) =>
	aiPost<AiResult<CollectionSpec>>(workspaceRootDir, 'schema', body);

export const aiForm = (workspaceRootDir: string, body: AiFormRequest) =>
	aiPost<AiResult<FormLayout>>(workspaceRootDir, 'form', body);

/** The visual schema editor's request: the whole schema plus words, the whole schema back. */
export const aiSchemaEdit = (workspaceRootDir: string, body: AiSchemaEditRequest) =>
	aiPost<AiSchemaEditResponse>(workspaceRootDir, 'schema-edit', body);

/**
 * Why the AI cannot be used from here, or null when it can: the editor shows
 * this instead of a working button.
 */
export function aiUnavailableReason(workspaceRootDir: string): string | null {
	if (!readProjectConfig(workspaceRootDir)) {
		return 'AI needs a project linked to velastack.dev: run `vela link` first.';
	}
	if (!readApiKey()) {
		return 'AI needs you signed in: run `vela login` first.';
	}
	return null;
}
