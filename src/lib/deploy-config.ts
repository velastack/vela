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
	deployments?: Record<string, DeploymentRecord>;
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

export interface DeploymentRecord {
	/** SSH target the last deploy of this environment used. */
	target: string;
	domain?: string;
}

/**
 * Remember where an environment was last deployed, so `vela env`, `vela status`
 * and `vela rollback` do not need the server spelled out every time.
 *
 * This is ordinary project metadata — the SSH target, never a credential — and
 * belongs in version control alongside the app id.
 */
export function recordDeployment(
	workspaceRootDir: string,
	envTag: string,
	record: DeploymentRecord
): void {
	const project = readProjectFile(workspaceRootDir) as ProjectFile & {
		deployments?: Record<string, DeploymentRecord>;
	};
	const deployments = { ...project.deployments, [envTag]: record };
	writeProjectFile(workspaceRootDir, { ...project, deployments });
}

export function readDeployment(workspaceRootDir: string, envTag: string): DeploymentRecord | null {
	const project = readProjectFile(workspaceRootDir) as ProjectFile & {
		deployments?: Record<string, DeploymentRecord>;
	};
	return project.deployments?.[envTag] ?? null;
}

/** The SSH target for a command that did not name one. */
export function resolveTarget(workspaceRootDir: string, envTag: string, explicit?: string): string {
	if (explicit) return explicit;
	const recorded = readDeployment(workspaceRootDir, envTag)?.target;
	if (recorded) return recorded;
	throw new Error(
		`No server given, and ${envTag} has not been deployed from this project yet.\n\n` +
			`Pass the SSH target, for example \`vela deploy myserver\`.`
	);
}
