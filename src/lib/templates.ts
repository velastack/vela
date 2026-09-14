import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_INDEX_URL } from './constants.ts';
import { restoreTemplateNames } from './template-files.ts';
import {
	downloadTemplate,
	fetchTemplateIndex,
	type RemoteTemplateEntry
} from './template-registry.ts';

/** Marks a directory under `templates/` as something `vela create` can scaffold. */
export const TEMPLATE_MANIFEST = 'template.json';

export const DEFAULT_TEMPLATE = 'minimal';

/** The category a manifest gets when it names none; the CLI's own starters. */
export const DEFAULT_CATEGORY = 'starter';

export type TemplateSource = 'builtin' | 'remote';

/** What every template, packaged or downloaded, says about itself. */
export interface TemplateInfo {
	/** Directory name under `templates/` (or registry name), and the value `--template` takes. */
	name: string;
	description: string;
	/**
	 * Whether the template scaffolds a PocketBase backend. A template without one
	 * is a frontend-only project: no superuser, no `.env`, no `vela dev`/`sync`.
	 */
	backend: boolean;
	source: TemplateSource;
	/** Groups templates in listings: `starter`, `blog`, ... */
	category: string;
	title?: string;
	tags?: string[];
	price?: number;
	/** Replaces the generic "what next" lines `vela create` prints. */
	nextSteps?: string[];
	/**
	 * Whether the template reads its copy from a hosted CMS through
	 * `site.cmsEndpoint` in `src/lib/site.ts`. `vela create` fills that in from
	 * the linked velastack.dev project, or asks where the CMS is.
	 */
	cms?: boolean;
}

/** A template with its files on disk, ready to copy. */
export interface ProjectTemplate extends TemplateInfo {
	dir: string;
}

/** A registry template that has not been downloaded yet. */
export interface RemoteTemplate extends TemplateInfo {
	source: 'remote';
	entry: RemoteTemplateEntry;
	indexUrl: string;
}

export type AnyTemplate = ProjectTemplate | RemoteTemplate;

/** A template ready to copy, plus the cleanup a downloaded one needs afterwards. */
export interface ResolvedTemplate extends ProjectTemplate {
	cleanup(): void;
}

export interface TemplateListing {
	templates: AnyTemplate[];
	/** Set when the registry contributed nothing (offline, bad URL, ...). */
	registryError?: string;
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
 * Every template that ships with the CLI, read from disk rather than hardcoded
 * so adding a template directory is all it takes to make `--template` accept it.
 *
 * Synchronous and registry-free on purpose: `vela bless` and the packaging tests
 * only care about built-ins and must not touch the network. `vela create` uses
 * `listAllTemplates` to add the registry on top.
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

/** Built-in template names accepted by `--template`, in the order they should be listed. */
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

/**
 * Built-in templates plus whatever the registry lists. A built-in wins over a
 * registry entry with the same name: nothing published later can silently
 * replace `minimal`.
 */
export async function listAllTemplates(
	options: { indexUrl?: string } = {}
): Promise<TemplateListing> {
	const indexUrl = options.indexUrl ?? TEMPLATE_INDEX_URL;
	const builtin = listProjectTemplates();
	const names = new Set(builtin.map((template) => template.name));
	const templates: AnyTemplate[] = [...builtin];

	const result = await fetchTemplateIndex(indexUrl);
	for (const entry of result.index?.templates ?? []) {
		if (names.has(entry.name)) continue;
		names.add(entry.name);
		templates.push({
			name: entry.name,
			description: entry.description,
			backend: entry.backend,
			source: 'remote',
			category: entry.category ?? DEFAULT_CATEGORY,
			title: entry.title,
			tags: entry.tags,
			price: entry.price,
			nextSteps: entry.nextSteps,
			cms: entry.cms,
			entry,
			indexUrl
		});
	}

	templates.sort(compareTemplates);
	return result.index ? { templates } : { templates, registryError: result.reason };
}

/** Starters first, then categories alphabetically, names alphabetically within each. */
function compareTemplates(a: TemplateInfo, b: TemplateInfo): number {
	if (a.category !== b.category) {
		if (a.category === DEFAULT_CATEGORY) return -1;
		if (b.category === DEFAULT_CATEGORY) return 1;
		return a.category.localeCompare(b.category);
	}
	return a.name.localeCompare(b.name);
}

export function findTemplate(listing: TemplateListing, name: string): AnyTemplate {
	const template = listing.templates.find((candidate) => candidate.name === name);
	if (!template) throw new Error(`Template not found: ${name}`);
	return template;
}

/**
 * `--template` choices grouped by category, for help and validation messages:
 * `starter: minimal, static; blog: broadsheet, confetti`.
 */
export function templateChoicesMessage(templates: TemplateInfo[]): string {
	const groups = new Map<string, string[]>();
	for (const template of [...templates].sort(compareTemplates)) {
		const names = groups.get(template.category) ?? [];
		names.push(template.name);
		groups.set(template.category, names);
	}
	return [...groups].map(([category, names]) => `${category}: ${names.join(', ')}`).join('; ');
}

/**
 * Put a template's files on disk. A built-in is already there; a registry
 * template is downloaded and unpacked into a temporary directory that
 * `cleanup()` removes once it has been copied into the project.
 */
export async function resolveTemplate(template: AnyTemplate): Promise<ResolvedTemplate> {
	if (!('entry' in template)) {
		return { ...template, cleanup() {} };
	}
	const { entry, indexUrl, ...info } = template;
	const dir = await downloadTemplate(entry, indexUrl);
	return {
		...info,
		dir,
		cleanup() {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	};
}

/** Copy a template's tree into `target`, restoring the names npm cannot publish. */
export function copyTemplate(template: ProjectTemplate, target: string): void {
	fs.mkdirSync(target, { recursive: true });
	fs.cpSync(template.dir, target, {
		recursive: true,
		// The manifest describes the template to the CLI; it isn't part of the project.
		filter: (src) =>
			path.basename(src) !== '.DS_Store' && path.relative(template.dir, src) !== TEMPLATE_MANIFEST
	});
	restoreTemplateNames(target);
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

	const manifest = parsed as Record<string, unknown>;
	if (typeof manifest.description !== 'string' || typeof manifest.backend !== 'boolean') {
		throw new Error(
			`Template ${name} has an invalid ${TEMPLATE_MANIFEST} (needs description and backend)`
		);
	}

	return {
		name,
		description: manifest.description,
		backend: manifest.backend,
		source: 'builtin',
		category: optionalString(manifest.category) ?? DEFAULT_CATEGORY,
		title: optionalString(manifest.title),
		tags: optionalStringArray(manifest.tags),
		price: typeof manifest.price === 'number' ? manifest.price : undefined,
		nextSteps: optionalStringArray(manifest.nextSteps),
		cms: typeof manifest.cms === 'boolean' ? manifest.cms : undefined,
		dir: path.join(root, name)
	};
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((item): item is string => typeof item === 'string');
	return strings.length > 0 ? strings : undefined;
}
