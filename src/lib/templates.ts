import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Marks a directory under `templates/` as something `vela create` can scaffold. */
export const TEMPLATE_MANIFEST = 'template.json';

export const DEFAULT_TEMPLATE = 'minimal';

export interface ProjectTemplate {
	/** Directory name under `templates/`, and the value `--template` takes. */
	name: string;
	description: string;
	/**
	 * Whether the template scaffolds a PocketBase backend. A template without one
	 * is a frontend-only project: no superuser, no `.env`, no `vela dev`/`sync`.
	 */
	backend: boolean;
	dir: string;
}

let cached: ProjectTemplate[] | undefined;

/**
 * The packaged `templates/` directory, found by walking up from this module so
 * it resolves the same whether the CLI runs from `src/` or from `dist/`.
 *
 * A bare `templates` name is too common to match on alone, so a candidate only
 * counts once it holds at least one template manifest.
 */
export function templatesDir(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	const { root } = path.parse(dir);
	while (dir !== root) {
		const candidate = path.join(dir, 'templates');
		if (holdsManifest(candidate)) return candidate;
		dir = path.dirname(dir);
	}
	throw new Error('Could not locate the templates directory');
}

function holdsManifest(dir: string): boolean {
	if (!fs.existsSync(dir)) return false;
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.some(
			(entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, TEMPLATE_MANIFEST))
		);
}

/**
 * Every scaffoldable template, read from disk rather than hardcoded so adding a
 * template directory is all it takes to make `--template` accept it.
 */
export function listProjectTemplates(): ProjectTemplate[] {
	if (cached) return cached;
	const root = templatesDir();
	cached = fs
		.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => readManifest(root, entry.name))
		.filter((template): template is ProjectTemplate => template !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name));
	return cached;
}

/** Template names accepted by `--template`, in the order they should be listed. */
export function projectTemplateNames(options: { backend?: boolean } = {}): string[] {
	const templates = listProjectTemplates();
	const matching =
		options.backend === undefined
			? templates
			: templates.filter((template) => template.backend === options.backend);
	return matching.map((template) => template.name);
}

export function findProjectTemplate(name: string): ProjectTemplate {
	const template = listProjectTemplates().find((candidate) => candidate.name === name);
	if (!template) throw new Error(`Template not found: ${name}`);
	return template;
}

function readManifest(root: string, name: string): ProjectTemplate | undefined {
	const manifestPath = path.join(root, name, TEMPLATE_MANIFEST);
	if (!fs.existsSync(manifestPath)) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (e) {
		throw new Error(
			`Template ${name} has an unreadable ${TEMPLATE_MANIFEST}: ${(e as Error).message}`
		);
	}

	const manifest = parsed as { description?: unknown; backend?: unknown };
	if (typeof manifest.description !== 'string' || typeof manifest.backend !== 'boolean') {
		throw new Error(
			`Template ${name} has an invalid ${TEMPLATE_MANIFEST} (needs description and backend)`
		);
	}

	return {
		name,
		description: manifest.description,
		backend: manifest.backend,
		dir: path.join(root, name)
	};
}
