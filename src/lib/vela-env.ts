import fs from 'node:fs';
import path from 'node:path';
import { modifyEnvVars, type EnvVarSpec } from '@velastack/patterns';

/**
 * The environment variables vela's own code reads: the hook that connects to
 * PocketBase and the workflow worker. Declared the way
 * `templates/minimal/src/env.ts` declares them (a test keeps the two in step),
 * so a project blessed or migrated by vela reads the same as one it created.
 */
export const VELA_ENV_VARS: EnvVarSpec[] = [
	{
		name: 'POCKETBASE_URL',
		description: 'Where PocketBase listens. `vela dev` and `vela deploy` set it.'
	},
	{
		name: 'POCKETBASE_SUPERUSER_EMAIL',
		description: 'Superuser email the server signs in with for admin features and workflows.'
	},
	{
		name: 'POCKETBASE_SUPERUSER_PASSWORD',
		description: 'Password for POCKETBASE_SUPERUSER_EMAIL.'
	},
	{
		name: 'WORKFLOWS_ENABLED',
		description: 'Set to `false` to stop this process running workflows; it can still start them.'
	},
	{
		name: 'WORKFLOWS_CONCURRENCY',
		description: 'How many workflow runs this process executes at once. Defaults to 5.'
	},
	{
		name: 'TEST',
		description: '`true` under `vela test:server`, which turns off the workflow cron schedules.'
	}
];

const SOURCE_EXTENSIONS = /\.(ts|js|mts|mjs|svelte)$/;

/** Every source file under `dir`, skipping dependencies and generated output. */
export function sourceFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.globSync('**/*', {
			cwd: dir,
			exclude: (name) => name === 'node_modules' || name === '.svelte-kit'
		})
		.filter((rel) => SOURCE_EXTENSIONS.test(rel) && !rel.endsWith('.d.ts'))
		.map((rel) => path.join(dir, rel))
		.filter((file) => fs.statSync(file).isFile());
}

const ENV_MODULE = String.raw`\$app/env/(?:private|public)|\$env/(?:static|dynamic)/(?:private|public)`;
const NAMED_IMPORT = new RegExp(
	String.raw`import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](${ENV_MODULE})['"]`,
	'g'
);

export interface EnvImport {
	/** The variable's name, as `.env` spells it. */
	name: string;
	/** What the file calls it: the name, or its alias. */
	local: string;
}

/**
 * The environment variables a source file reads by name: named imports from
 * `$app/env/*` (and the `$env/static/*` and `$env/dynamic/*` aliases Kit 3
 * still accepts), plus `env.NAME` after an `env` import from `$env/dynamic/*`.
 * Text, not an AST: good enough to decide what to declare, and it reads
 * `.svelte` files without a compiler.
 */
export function envImports(source: string): EnvImport[] {
	const found = new Map<string, EnvImport>();
	for (const match of source.matchAll(NAMED_IMPORT)) {
		const dynamicNamespace = match[2]!.startsWith('$env/dynamic/');
		for (const raw of match[1]!.split(',')) {
			const spec = raw.trim().replace(/^type\s+/, '');
			if (!spec) continue;
			const [name, local = name] = spec.split(/\s+as\s+/).map((s) => s.trim()) as [string, string?];
			if (dynamicNamespace && name === 'env') {
				for (const ref of source.matchAll(
					new RegExp(String.raw`\b${local}\.([A-Z_][A-Z0-9_]*)`, 'g')
				)) {
					found.set(ref[1]!, { name: ref[1]!, local: `${local}.${ref[1]}` });
				}
				continue;
			}
			if (/^[A-Za-z_$][\w$]*$/.test(name)) found.set(name, { name, local: local! });
		}
	}
	return [...found.values()];
}

/** The names of the environment variables any file under `src` reads. */
export function envNamesRead(root: string): Set<string> {
	const names = new Set<string>();
	for (const file of sourceFiles(path.join(root, 'src'))) {
		for (const { name } of envImports(fs.readFileSync(file, 'utf8'))) names.add(name);
	}
	return names;
}

export interface EnvDeclarationOutcome {
	/** Project-relative path of the declaration file, when one was involved. */
	file?: string;
	changed: boolean;
	/** The variables asked for. */
	declared: string[];
	/** Set when the file could not be edited: what to paste, and where. */
	failure?: string;
}

/**
 * Declare `specs` in the project's `src/env.ts`, creating it when there is
 * none. Entries already there are the project's and are never touched.
 */
export async function ensureEnvDeclarations(
	root: string,
	specs: EnvVarSpec[]
): Promise<EnvDeclarationOutcome> {
	const declared = specs.map((s) => s.name);
	if (specs.length === 0) return { changed: false, declared };
	const result = await modifyEnvVars(root, specs);
	if (result.create) {
		fs.mkdirSync(path.dirname(result.create.path), { recursive: true });
		fs.writeFileSync(result.create.path, result.create.content);
		return { file: path.relative(root, result.create.path), changed: true, declared };
	}
	if (result.modify) {
		const file = path.relative(root, result.modify.filePath);
		const { outcome } = result.modify;
		if (outcome.status !== 'success')
			return { file, changed: false, declared, failure: outcome.message };
		return { file, changed: outcome.changed, declared };
	}
	return { changed: false, declared };
}
