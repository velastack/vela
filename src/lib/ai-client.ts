import { API_URL } from './constants.ts';
import { requireApiKey } from './config.ts';
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

async function aiPost<T>(
	workspaceRootDir: string,
	endpoint: 'schema' | 'form',
	body: AiSchemaRequest | AiFormRequest
): Promise<AiResult<T>> {
	const apiKey = requireApiKey();
	const project = readProjectConfig(workspaceRootDir);
	if (!project) {
		throw new Error("This isn't a velastack project (no .vela/project.json). Run `vela create` first.");
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
	return (await res.json()) as AiResult<T>;
}

export const aiSchema = (workspaceRootDir: string, body: AiSchemaRequest) =>
	aiPost<CollectionSpec>(workspaceRootDir, 'schema', body);

export const aiForm = (workspaceRootDir: string, body: AiFormRequest) =>
	aiPost<FormLayout>(workspaceRootDir, 'form', body);
