import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readPackageJson } from './package-json.ts';

/**
 * Per-project deploy settings, read from `velastack.config.{ts,js,mjs,json}` at
 * the workspace root. Every field is optional — a project with no config file at
 * all can still be deployed, it just has to pass `--domain` the first time.
 */
export interface VelaDeployConfig {
	/** Public hostname Caddy should serve this app on. */
	domain?: string;
	/** Path the deploy health check hits on the app's own port. */
	healthCheckPath?: string;
	/** Build command run locally before packing the artifact. */
	buildCommand?: string;
	/** Directory the adapter writes to. */
	outputDir?: string;
	/** Extra files or directories to include in the release artifact. */
	include?: string[];
	/** How many old releases to keep on the server. */
	keepReleases?: number;
	/** PocketBase version to run. Defaults to the one this CLI develops against. */
	pocketbaseVersion?: string;
	/**
	 * Render the build against the deployed instance's database rather than a
	 * throwaway local one. Needed when pages are prerendered from data, which
	 * would otherwise bake in the defaults of an empty database.
	 */
	buildAgainstRemote?: boolean;
}

export interface VelaAppConfig {
	project?: string;
	deploy?: VelaDeployConfig;
}

const CONFIG_BASENAMES = [
	'velastack.config.ts',
	'velastack.config.js',
	'velastack.config.mjs',
	'velastack.config.json'
];

export function findConfigFile(workspaceRootDir: string): string | null {
	for (const name of CONFIG_BASENAMES) {
		const file = path.join(workspaceRootDir, name);
		if (fs.existsSync(file)) return file;
	}
	return null;
}

export async function loadDeployConfig(workspaceRootDir: string): Promise<VelaAppConfig> {
	const file = findConfigFile(workspaceRootDir);
	if (!file) return {};

	if (file.endsWith('.json')) {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as VelaAppConfig;
	}

	const url = file.endsWith('.ts') ? await transpileToTemp(file) : pathToFileURL(file).href;
	try {
		const mod = (await import(url)) as { default?: VelaAppConfig };
		const config = mod.default;
		if (!config || typeof config !== 'object') {
			throw new Error(`${path.basename(file)} must export a config object as its default export.`);
		}
		return config;
	} finally {
		if (url !== pathToFileURL(file).href) fs.rmSync(new URL(url), { force: true });
	}
}

/**
 * Type annotations are stripped with the TypeScript compiler that ships with
 * ts-morph — already a dependency — rather than relying on the host Node having
 * type stripping enabled. The temp file sits beside the original so relative
 * imports still resolve.
 */
async function transpileToTemp(file: string): Promise<string> {
	const { ts } = await import('ts-morph');
	const source = fs.readFileSync(file, 'utf8');
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
	});
	const temp = path.join(
		path.dirname(file),
		`.velastack.config.${crypto.randomBytes(4).toString('hex')}.mjs`
	);
	fs.writeFileSync(temp, outputText);
	return pathToFileURL(temp).href;
}

/** Identity of a deployable app, stable for the lifetime of the project. */
export interface AppIdentity {
	/** Immutable id used for server paths and unit names. */
	appId: string;
	/** Human-readable name, used in output and for the `by-name` symlink. */
	name: string;
}

interface ProjectFile {
	projectId?: string;
	teamId?: string;
	projectName?: string;
	appId?: string;
	targets?: Record<string, TargetBinding>;
	/**
	 * The shape before targets were named. Still read, never written: a project
	 * deployed with an older CLI keeps working, and is rewritten into `targets`
	 * the next time it deploys.
	 */
	deployments?: Record<string, LegacyDeployment>;
}

function projectFilePath(workspaceRootDir: string): string {
	return path.join(workspaceRootDir, '.vela', 'project.json');
}

function readProjectFile(workspaceRootDir: string): ProjectFile {
	const file = projectFilePath(workspaceRootDir);
	if (!fs.existsSync(file)) return {};
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectFile;
	} catch {
		return {};
	}
}

function writeProjectFile(workspaceRootDir: string, data: ProjectFile): void {
	const file = projectFilePath(workspaceRootDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Resolve — and on first use, mint — the app's immutable id.
 *
 * A project already linked to velastack.dev reuses its project id. Everything
 * else gets a locally generated one, so deploying to your own VPS never
 * requires an account. Either way the id is written to `.vela/project.json` and
 * never recomputed: server paths and env files hang off it, so it has to
 * survive renames.
 */
export function resolveAppIdentity(
	workspaceRootDir: string,
	config: VelaAppConfig = {}
): AppIdentity {
	const project = readProjectFile(workspaceRootDir);
	const name = config.project ?? project.projectName ?? defaultProjectName(workspaceRootDir);

	if (project.appId) return { appId: project.appId, name };

	const appId = project.projectId ?? `${slug(name)}-${crypto.randomBytes(4).toString('hex')}`;
	writeProjectFile(workspaceRootDir, {
		...project,
		appId,
		projectName: project.projectName ?? name
	});
	return { appId, name };
}

/** Read the app id without minting one — for commands that must not create state. */
export function readAppIdentity(
	workspaceRootDir: string,
	config: VelaAppConfig = {}
): AppIdentity | null {
	const project = readProjectFile(workspaceRootDir);
	const appId = project.appId ?? project.projectId;
	if (!appId) return null;
	return {
		appId,
		name: config.project ?? project.projectName ?? defaultProjectName(workspaceRootDir)
	};
}

export function defaultProjectName(workspaceRootDir: string): string {
	try {
		const pkg = readPackageJson(path.join(workspaceRootDir, 'package.json'));
		if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
	} catch {
		// fall through to the directory name
	}
	return path.basename(workspaceRootDir);
}

function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/^@/, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 32) || 'app'
	);
}

export interface TargetBinding {
	/** SSH destination, exactly as `ssh` would take it. */
	server: string;
	/** Hostname(s) Caddy serves this target on. */
	domain?: string;
}

interface LegacyDeployment {
	target: string;
	domain?: string;
}

/**
 * Where a target runs.
 *
 * This is ordinary project metadata — a hostname, never a credential — and
 * belongs in version control beside the app id. Binding a target to a server
 * once is what lets every other command take `-t staging` and nothing else.
 */
export function readBinding(workspaceRootDir: string, envTag: string): TargetBinding | null {
	const project = readProjectFile(workspaceRootDir);
	const bound = project.targets?.[envTag];
	if (bound?.server) return bound;

	const legacy = project.deployments?.[envTag];
	if (legacy?.target) return { server: legacy.target, domain: legacy.domain };

	return null;
}

/** Every bound target, newest shape taking precedence over the old one. */
export function readBindings(workspaceRootDir: string): Record<string, TargetBinding> {
	const project = readProjectFile(workspaceRootDir);
	const bindings: Record<string, TargetBinding> = {};

	for (const [envTag, legacy] of Object.entries(project.deployments ?? {})) {
		if (legacy?.target) bindings[envTag] = { server: legacy.target, domain: legacy.domain };
	}
	for (const [envTag, bound] of Object.entries(project.targets ?? {})) {
		if (bound?.server) bindings[envTag] = bound;
	}

	return bindings;
}

export function writeBinding(
	workspaceRootDir: string,
	envTag: string,
	binding: TargetBinding
): void {
	const project = readProjectFile(workspaceRootDir);
	writeProjectFile(workspaceRootDir, {
		...project,
		targets: { ...project.targets, [envTag]: binding }
	});
}
