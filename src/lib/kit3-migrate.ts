import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as p from '@clack/prompts';
import { x } from 'tinyexec';
import { detect } from 'package-manager-detector';
import {
	ADAPTER_NODE,
	ADAPTER_STATIC,
	FLASH,
	NEGOTIATE,
	SUPERFORMS_VERSION,
	VELASTACK_CMS,
	VELASTACK_KIT,
	VELASTACK_POCKETBASE
} from '@velastack/patterns';
import { mergeOriginConfig, mergeTsconfig } from './config-merge.ts';
import { inspectViteSveltekit } from './config-target.ts';
import { kitStatus } from './kit-version.ts';
import {
	compareVersions,
	ensureLibImports,
	minVersion,
	raiseFloor,
	type PkgJson
} from './package-json.ts';
import { installDependencies } from './package-manager.ts';
import { hasBackend } from './workspace.ts';
import {
	envImports,
	ensureEnvDeclarations,
	envNamesRead,
	sourceFiles,
	VELA_ENV_VARS
} from './vela-env.ts';
import {
	rewriteComponentsJsonAliases,
	rewriteLibOutsideSrc,
	rewriteLibSpecifiers
} from './lib-rewrite.ts';
import { MIGRATION_TASK_MARKER, rewriteKit3Code } from './kit3-rewrites.ts';
import pkg from '../../package.json' with { type: 'json' };

/**
 * `vela migrate sveltekit-3`: sv's migration, then what vela projects need on
 * top of it.
 *
 * sv (`sv migrate sveltekit-3`, a dependency of this package, not npx) does
 * the framework work: config out of svelte.config, `$app/env`, `#lib`, hook
 * types. It has blind spots this fills in, each found migrating real projects:
 *
 * - it parses gitignored output (`dist/`, `build/`, `.svelte-kit/`) and aborts
 *   on it, so those are cleared first;
 * - one file it cannot parse aborts the whole run, so a failed task is re-run
 *   on its own with that file excluded (`--files`), and the rest one by one;
 * - it only flags `goto` `noScroll`/`keepFocus` and `invalidateAll`, and
 *   misses `vi.doMock('$app/environment')` (kit3-rewrites.ts);
 * - it drops spread properties from svelte.config, vela's origin among them,
 *   and never touches an inline `prerender.origin` (mergeOriginConfig);
 * - it rewrites `$lib` under `src/` only (lib-rewrite.ts);
 * - it leaves a Kit 2 lockfile that makes the next install fail ERESOLVE.
 *
 * Every step is idempotent, and a project already on Kit 3 with no
 * svelte.config skips sv and runs only vela's steps ("repair mode"), so
 * running the command twice changes nothing the second time.
 */

/** The Node SvelteKit 3 needs. */
export const NODE_FLOOR = '22.17.0';

/**
 * sv 1.0's selectable sveltekit-3 tasks, in the order it runs them (pinned by
 * `sv ~1.0.1`). `package-json` and `tsconfig` are prerequisites sv runs on
 * every invocation.
 */
export const SV_TASKS = [
	'svelte-config',
	'environment',
	'paths',
	'external-redirects',
	'shallow-routing',
	'params',
	'imports',
	'lib-alias',
	'app-state',
	'collect-migration-instructions'
] as const;

export const MIGRATION_TASKS_FILE = 'MIGRATION_TASKS.md';
const FOLLOW_UPS_HEADING = '## VelaStack follow-ups';

export class Kit3MigrationError extends Error {
	override name = 'Kit3MigrationError';
}

export interface SvResult {
	code: number;
	/** stdout and stderr, as printed. */
	output: string;
}

/** Runs `sv <args>` in `cwd`. Injectable so tests never spawn sv. */
export type SvRunner = (
	args: string[],
	options: { cwd: string; quiet: boolean }
) => Promise<SvResult>;

export interface MigrationLog {
	step(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	success(message: string): void;
}

export interface Kit3MigrationOptions {
	/** Refuse a dirty or missing git tree. Default true; `vela create` passes false. */
	gitCheck?: boolean;
	/** Run on a dirty tree anyway. */
	force?: boolean;
	/** Install dependencies at the end. Default true. */
	install?: boolean;
	/** Only vela's steps, even on a Kit 2 project (sv has already been run). */
	skipSv?: boolean;
	/** Keep sv's output and the step-by-step log out of the terminal. */
	quiet?: boolean;
	runSv?: SvRunner;
	/** Install with this instead of the project's package manager (tests). */
	installer?: (root: string) => Promise<boolean>;
	log?: MigrationLog;
	/** Overrides for tests. */
	nodeVersion?: string;
	cliVersion?: string;
}

export interface SvTaskFailure {
	task: string;
	/** Project-relative file sv could not process, when it said which. */
	file?: string;
	message: string;
}

export interface SvSummary {
	ran: boolean;
	/** Why sv was skipped. */
	skipped?: string;
	failures: SvTaskFailure[];
	/** Files sv was told to leave alone after it failed on them. */
	excluded: string[];
	/** Output directories removed before sv ran. */
	cleared: string[];
}

export interface Fixup {
	name: string;
	changed: boolean;
	details: string[];
	warnings: string[];
}

export interface MigrationTasksSummary {
	sections: Array<{ title: string; files: string[] }>;
	filesToReview: number;
	markerComments: number;
}

export interface Kit3MigrationResult {
	mode: 'migrate' | 'repair';
	sv: SvSummary;
	fixups: Fixup[];
	followUps: string[];
	/** Follow-ups that apply to every project (e.g. the server's Node). */
	genericFollowUps: string[];
	tasks: MigrationTasksSummary | null;
	installed: boolean | null;
	/** Changed files run through the project's prettier after the install. */
	formatted: string[];
}

const clackLog: MigrationLog = {
	step: (m) => p.log.step(m),
	info: (m) => p.log.info(m),
	warn: (m) => p.log.warn(m),
	success: (m) => p.log.success(m)
};

export async function runKit3Migration(
	root: string,
	options: Kit3MigrationOptions = {}
): Promise<Kit3MigrationResult> {
	const quiet = options.quiet ?? false;
	const base = options.log ?? clackLog;
	const log: MigrationLog = quiet
		? { ...base, step: () => {}, info: () => {}, success: () => {} }
		: base;

	const mode = await preflight(root, options);
	// Files already changed are the user's; the formatting pass leaves them alone.
	const dirtyBefore = new Set(gitDirty(root) ?? []);

	const sv: SvSummary = { ran: false, failures: [], excluded: [], cleared: [] };
	if (mode === 'repair') {
		sv.skipped = 'SvelteKit 3 already, with no svelte.config: running only the vela steps';
		log.info('Already on SvelteKit 3: skipping sv and re-checking the vela steps.');
	} else if (options.skipSv) {
		sv.skipped = '--skip-sv';
		log.info('Skipping sv (--skip-sv).');
	} else {
		log.step('Running sv migrate sveltekit-3...');
		sv.cleared = clearOutputDirs(root, log);
		await runSv(root, options.runSv ?? defaultSvRunner, quiet, sv, log);
		sv.ran = true;
	}

	log.step('Applying the vela steps...');
	const cliVersion = options.cliVersion ?? pkg.version;
	const fixups: Fixup[] = [
		originFixup(root),
		await envFixup(root),
		libFixup(root, sv.excluded),
		codeFixup(root),
		tsconfigFixup(root),
		packageFixup(root, cliVersion),
		lockfileFixup(root)
	];
	for (const fixup of fixups) {
		if (fixup.changed) log.info(`${fixup.name}: ${fixup.details.join('; ')}`);
		for (const warning of fixup.warnings) log.warn(`${fixup.name}: ${warning}`);
	}

	let installed: boolean | null = null;
	let formatted: string[] = [];
	if (options.install !== false) {
		installed = options.installer ? await options.installer(root) : await install(root);
		// sv formats what it wrote with the project's prettier, which a project
		// without node_modules does not have yet. Now it does.
		if (installed) formatted = await formatChanged(root, dirtyBefore);
	}

	// After formatting, so what they quote is what the files now say.
	const followUps = collectFollowUps(root, sv);
	// What sv could not do is only known on the run that ran it: a later run
	// keeps those items rather than dropping them unresolved.
	if (!sv.ran) followUps.unshift(...previousSvFollowUps(root));
	// `vela deploy` runs adapter-node apps; anything else is hosted elsewhere.
	const genericFollowUps = depRange(
		readJson(path.join(root, 'package.json')).data,
		'@sveltejs/adapter-node'
	)
		? [
				'Servers need Node 22.17 or later: run `vela provision` on each before the first SvelteKit 3 deploy.'
			]
		: [];
	writeFollowUps(root, followUps, genericFollowUps);
	const tasks = summarizeMigrationTasks(root);

	return { mode, sv, fixups, followUps, genericFollowUps, tasks, installed, formatted };
}

async function preflight(
	root: string,
	options: Kit3MigrationOptions
): Promise<'migrate' | 'repair'> {
	const node = minVersion(options.nodeVersion ?? process.versions.node);
	if (!node || compareVersions(node, minVersion(NODE_FLOOR)!) < 0) {
		throw new Kit3MigrationError(
			`SvelteKit 3 needs Node ${NODE_FLOOR} or later; this is Node ${options.nodeVersion ?? process.versions.node}.`
		);
	}

	const pkgPath = path.join(root, 'package.json');
	if (!fs.existsSync(pkgPath)) throw new Kit3MigrationError(`No package.json found in ${root}.`);
	const project = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PkgJson;
	if (!project.devDependencies?.['@sveltejs/kit']) {
		throw new Kit3MigrationError(
			project.dependencies?.['@sveltejs/kit']
				? '@sveltejs/kit is in dependencies; sv migrates it only from devDependencies. Move it there and run this again.'
				: `@sveltejs/kit is not a devDependency in ${pkgPath}: this does not look like a SvelteKit project.`
		);
	}

	const status = kitStatus(root);
	const installedMajor = status.installedVersion
		? (minVersion(status.installedVersion)?.major ?? null)
		: null;
	const major = status.declaredMajor ?? installedMajor;
	if (major !== null && major < 2) {
		throw new Kit3MigrationError(
			`This project is on SvelteKit ${major}. Upgrade it to SvelteKit 2 first (npx sv migrate sveltekit-2), then run this again.`
		);
	}

	if (options.gitCheck !== false && !options.force) {
		const dirty = gitDirty(root);
		if (dirty === null) {
			throw new Kit3MigrationError(
				`${root} is not in a git repository, so the migration could not be reviewed or undone. Commit it to git first, or pass --force.`
			);
		}
		if (dirty.length > 0) {
			const shown = dirty.slice(0, 10).map((f) => `  ${f}`);
			if (dirty.length > 10) shown.push(`  …and ${dirty.length - 10} more`);
			throw new Kit3MigrationError(
				`The git working tree has uncommitted changes. Commit or stash them first so the migration's changes can be reviewed on their own, or pass --force:\n${shown.join('\n')}`
			);
		}
	}

	return major !== null && major >= 3 && !status.svelteConfig ? 'repair' : 'migrate';
}

/** Changed or untracked paths, or null outside a git repository. */
function gitDirty(root: string): string[] | null {
	if (spawnSync('git', ['rev-parse', '--is-inside-work-tree'], root) === null) return null;
	const lines = (out: string | null) => (out ?? '').split('\n').filter(Boolean);
	// Relative to `root`, which may be a package inside a larger repository.
	const untracked = lines(spawnSync('git', ['ls-files', '--others', '--exclude-standard'], root));
	const hasHead = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], root) !== null;
	const tracked = hasHead
		? lines(spawnSync('git', ['diff', '--name-only', '--relative', 'HEAD'], root))
		: lines(spawnSync('git', ['ls-files'], root));
	return [...new Set([...tracked, ...untracked])].sort();
}

/** stdout of a command that exited 0, or null. */
function spawnSync(command: string, args: string[], cwd: string): string | null {
	try {
		return execFileSync(command, args, {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
	} catch {
		return null;
	}
}

const require_ = createRequire(import.meta.url);

const OUTPUT_DIRS = new Set(['dist', 'build', '.svelte-kit']);

/**
 * Remove build output sv would otherwise parse (and abort on): `dist/`,
 * `build/` and `.svelte-kit/` anywhere outside node_modules, when git says
 * they are ignored. `.svelte-kit` is always generated, so it goes even
 * without git; the others are only reported.
 */
export function clearOutputDirs(root: string, log: MigrationLog): string[] {
	const cleared: string[] = [];
	const inGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], root) !== null;
	const walk = (dir: string, depth: number) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
			const full = path.join(dir, entry.name);
			const rel = path.relative(root, full);
			if (OUTPUT_DIRS.has(entry.name)) {
				const ignored = inGit
					? spawnSync('git', ['check-ignore', '-q', rel], root) !== null
					: entry.name === '.svelte-kit';
				if (ignored) {
					fs.rmSync(full, { recursive: true, force: true });
					cleared.push(rel);
				} else if (entry.name !== '.svelte-kit') {
					log.warn(
						`${rel} is not ignored by git, so it was left in place; sv may fail to parse what is in it.`
					);
				}
				continue;
			}
			if (entry.name.startsWith('.') || depth >= 3) continue;
			walk(full, depth + 1);
		}
	};
	walk(root, 0);
	if (cleared.length > 0) log.info(`Removed build output before running sv: ${cleared.join(', ')}`);
	return cleared;
}

/** The `sv` bin this package depends on, resolved without npx. */
export function svBin(): string {
	const entry = require_.resolve('sv');
	let dir = path.dirname(entry);
	while (dir !== path.dirname(dir)) {
		const manifest = path.join(dir, 'package.json');
		if (fs.existsSync(manifest)) {
			const data = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
				name?: string;
				bin?: unknown;
			};
			if (data.name === 'sv') {
				const bin =
					typeof data.bin === 'string' ? data.bin : (data.bin as Record<string, string>)?.sv;
				if (!bin) throw new Kit3MigrationError('The installed sv package has no bin.');
				return path.join(dir, bin);
			}
		}
		dir = path.dirname(dir);
	}
	throw new Kit3MigrationError('Could not find the sv package vela depends on. Reinstall vela.');
}

/**
 * sv through the running Node, its output passed through as it comes and
 * kept, so a failed task can be read back out of it.
 */
export const defaultSvRunner: SvRunner = (args, { cwd, quiet }) =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [svBin(), ...args], {
			cwd,
			stdio: ['inherit', 'pipe', 'pipe'],
			env: process.env
		});
		let output = '';
		child.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString();
			if (!quiet) process.stdout.write(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			output += chunk.toString();
			if (!quiet) process.stderr.write(chunk);
		});
		child.on('error', reject);
		child.on('close', (code) => resolve({ code: code ?? 1, output }));
	});

export function svArgs(root: string, tasks: string, exclude: string[]): string[] {
	const args = [
		'migrate',
		'sveltekit-3',
		'--cwd',
		root,
		'--tasks',
		tasks,
		'--confirm',
		'--no-install',
		'--no-git-check'
	];
	if (exclude.length > 0) args.push('--files', excludeGlob(exclude));
	return args;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** The task sv reported failing, and the file it was processing, from its output. */
export function parseSvFailure(output: string): SvTaskFailure | null {
	const text = output.replace(ANSI, '');
	const match = text.match(/Task '([^']+)' failed: ([^\n]*)/);
	if (!match) return null;
	const message = match[2]!.trim();
	const file = message.match(/Unable to process '([^']+)'/)?.[1];
	return { task: match[1]!, ...(file ? { file } : {}), message };
}

/** A glob character as a one-character class, which is how `path.matchesGlob` escapes. */
function globLiteral(segment: string): string {
	return segment.replace(/[[\]{}()*?+@!,|]/g, (c) => `[${c}]`);
}

/**
 * A `--files` glob matching every project file except `files`. sv tests each
 * path with `path.matchesGlob`, which has no "everything but" form across
 * directories, so this negates one path segment at a time:
 * `{!(src),!(src)/**,src/!(lib),src/!(lib)/**,src/lib/!(x.ts),...}`.
 */
export function excludeGlob(files: string[]): string {
	type Trie = Map<string, Trie>;
	const trie: Trie = new Map();
	for (const file of files) {
		let node = trie;
		for (const segment of file.split(/[\\/]/)) {
			if (!node.has(segment)) node.set(segment, new Map());
			node = node.get(segment)!;
		}
	}
	const alternatives: string[] = [];
	const walk = (node: Trie, prefix: string) => {
		const negated = `${prefix}!(${[...node.keys()].map(globLiteral).join('|')})`;
		alternatives.push(negated, `${negated}/**`);
		for (const [segment, child] of node) {
			if (child.size > 0) walk(child, `${prefix}${globLiteral(segment)}/`);
		}
	};
	walk(trie, '');
	return `{${alternatives.join(',')}}`;
}

const MAX_RETRIES_PER_TASK = 10;

async function runSv(
	root: string,
	runner: SvRunner,
	quiet: boolean,
	summary: SvSummary,
	log: MigrationLog
): Promise<void> {
	const first = await runner(svArgs(root, 'all', []), { cwd: root, quiet });
	if (first.code === 0) return;

	const failure = parseSvFailure(first.output);
	if (!failure) {
		throw new Kit3MigrationError(
			`sv migrate sveltekit-3 failed (exit code ${first.code}). Its output is above.`
		);
	}
	const index = (SV_TASKS as readonly string[]).indexOf(failure.task);
	if (index === -1) {
		throw new Kit3MigrationError(`sv's ${failure.task} step failed: ${failure.message}`);
	}
	record(failure);

	for (let i = index; i < SV_TASKS.length; i++) {
		const task = SV_TASKS[i]!;
		// A task that failed without naming a file has nothing to exclude.
		if (i === index && !failure.file) continue;
		for (let attempt = 0; attempt < MAX_RETRIES_PER_TASK; attempt++) {
			log.info(
				`Re-running sv task ${task}${summary.excluded.length ? `, skipping ${summary.excluded.join(', ')}` : ''}...`
			);
			const result = await runner(svArgs(root, task, summary.excluded), { cwd: root, quiet });
			if (result.code === 0) break;
			const again = parseSvFailure(result.output);
			if (!again || (again.task !== task && (SV_TASKS as readonly string[]).includes(again.task))) {
				throw new Kit3MigrationError(
					`sv migrate sveltekit-3 --tasks ${task} failed (exit code ${result.code}). Its output is above.`
				);
			}
			if (again.task !== task) {
				// A prerequisite (package-json, tsconfig) failed: nothing to skip past.
				throw new Kit3MigrationError(`sv's ${again.task} step failed: ${again.message}`);
			}
			// Nothing new to skip means the same failure would come back: move on.
			const retry = again.file !== undefined && !summary.excluded.includes(again.file);
			record(again);
			if (!retry) break;
		}
	}

	function record(f: SvTaskFailure) {
		summary.failures.push(f);
		if (f.file && !summary.excluded.includes(f.file)) summary.excluded.push(f.file);
		log.warn(
			f.file
				? `sv's ${f.task} task could not process ${f.file}: ${f.message.replace(/^Unable to process '[^']+'\. Reason: /, '')}`
				: `sv's ${f.task} task failed: ${f.message}`
		);
	}
}

function fixup(name: string): Fixup {
	return { name, changed: false, details: [], warnings: [] };
}

function originFixup(root: string): Fixup {
	const f = fixup('origin');
	const outcome = mergeOriginConfig(root);
	if (outcome.applied) {
		f.changed = true;
		f.details.push(`${outcome.file}: ${outcome.reason}`);
	} else if (outcome.snippet) {
		f.warnings.push(`${outcome.file ?? 'vite.config'}: ${outcome.reason}\n${outcome.snippet}`);
	}
	return f;
}

/**
 * Declare the vela variables the project reads and has not declared. sv's
 * `environment` task usually has already (with its own schemas, which are
 * left as they are); this catches a project sv was skipped on, and code that
 * still reads through the `$env/*` aliases.
 */
async function envFixup(root: string): Promise<Fixup> {
	const f = fixup('src/env.ts');
	const read = envNamesRead(root);
	const specs = VELA_ENV_VARS.filter((spec) => read.has(spec.name));
	const outcome = await ensureEnvDeclarations(root, specs);
	if (outcome.failure) f.warnings.push(outcome.failure);
	else if (outcome.changed) {
		f.changed = true;
		f.details.push(`declared ${specs.map((s) => s.name).join(', ')} in ${outcome.file}`);
	}
	return f;
}

function libFixup(root: string, skippedBySv: string[]): Fixup {
	const f = fixup('#lib');
	const pkgPath = path.join(root, 'package.json');
	const { data, indent } = readJson(pkgPath);
	if (ensureLibImports(data)) {
		writeJson(pkgPath, data, indent);
		f.changed = true;
		f.details.push('package.json imports #lib, #lib/*');
	}
	const components = rewriteComponentsJsonAliases(root);
	if (components) {
		f.changed = true;
		f.details.push(`components.json aliases ${components.changes.join(', ')}`);
	}
	// sv's lib-alias task never saw the files it was told to skip.
	for (const rel of skippedBySv) {
		const file = path.join(root, rel);
		if (!fs.existsSync(file)) continue;
		const source = fs.readFileSync(file, 'utf8');
		const { code, changes, unresolved } = rewriteLibSpecifiers(root, source);
		for (const u of unresolved)
			f.warnings.push(`${rel}: ${u} names nothing under src/lib; change it by hand`);
		if (code === source) continue;
		fs.writeFileSync(file, code);
		f.changed = true;
		f.details.push(`${rel} (skipped by sv): ${changes.join(', ')}`);
	}
	const outside = rewriteLibOutsideSrc(root);
	for (const r of outside.rewritten) {
		f.changed = true;
		f.details.push(`${r.file}: ${r.changes.join(', ')}`);
	}
	for (const u of outside.unresolved)
		f.warnings.push(`${u} names nothing under src/lib; change it by hand`);
	return f;
}

function codeFixup(root: string): Fixup {
	const f = fixup('code');
	for (const r of rewriteKit3Code(root)) {
		f.changed = true;
		for (const change of r.changes) f.details.push(`${r.file} ${change}`);
		for (const task of r.tasks)
			f.warnings.push(`${r.file} ${task} (left as an ${MIGRATION_TASK_MARKER} comment)`);
	}
	return f;
}

function tsconfigFixup(root: string): Fixup {
	const f = fixup('tsconfig.json');
	const outcome = mergeTsconfig(root, { backend: hasBackend(root) });
	if (outcome.applied) {
		f.changed = true;
		f.details.push(outcome.reason);
	} else if (outcome.snippet) {
		f.warnings.push(`${outcome.reason}\n${outcome.snippet}`);
	}
	return f;
}

/** `name@range` from patterns' constants. */
function splitSpec(spec: string): [string, string] {
	const at = spec.lastIndexOf('@');
	return [spec.slice(0, at), spec.slice(at + 1)];
}

/** Floors SvelteKit 3 needs; raised only where the project has the package. */
const FLOORS: Array<[string, string]> = [
	['@sveltejs/kit', '^3.0.0'],
	splitSpec(ADAPTER_NODE),
	splitSpec(ADAPTER_STATIC),
	['@sveltejs/adapter-auto', '^8.0.0'],
	['@sveltejs/package', '^3.0.0'],
	['@sveltejs/vite-plugin-svelte', '^7.3.1'],
	['svelte', '^5.57.1'],
	['vite', '^8.0.12'],
	['svelte-check', '^4.7.6'],
	['typescript', '^6.0.0'],
	['shadcn-svelte', '^1.7.0'],
	splitSpec(VELASTACK_KIT),
	splitSpec(VELASTACK_POCKETBASE),
	splitSpec(VELASTACK_CMS),
	splitSpec(NEGOTIATE)
];

/** Installed exactly: a caret on a prerelease would follow later `next` builds. */
const EXACT_PINS: Array<[string, string]> = [
	['sveltekit-superforms', SUPERFORMS_VERSION],
	splitSpec(FLASH)
];

const ENGINES_FLOOR = '>=22.17';

function packageFixup(root: string, cliVersion: string): Fixup {
	const f = fixup('package.json');
	const pkgPath = path.join(root, 'package.json');
	const { data, indent } = readJson(pkgPath);
	const changed: string[] = [];

	for (const [name, range] of [...FLOORS, ['vela', `^${cliVersion}`] as [string, string]]) {
		const before = depRange(data, name);
		if (raiseFloor(data, name, range)) changed.push(`${name} ${before} → ${range}`);
	}
	for (const [name, version] of EXACT_PINS) {
		for (const kind of ['dependencies', 'devDependencies'] as const) {
			const current = data[kind]?.[name];
			if (current === undefined || current === version || current.includes(':')) continue;
			data[kind]![name] = version;
			changed.push(`${name} ${current} → ${version}`);
		}
	}

	const engines = (data.engines ?? {}) as Record<string, string>;
	const nodeFloor = engines.node ? minVersion(engines.node) : null;
	if (!engines.node || (nodeFloor && compareVersions(nodeFloor, minVersion(NODE_FLOOR)!) < 0)) {
		changed.push(`engines.node ${engines.node ?? '(unset)'} → ${ENGINES_FLOOR}`);
		data.engines = { ...engines, node: ENGINES_FLOOR };
	}

	if (depRange(data, 'formsnap') !== undefined) {
		// formsnap 2 peers superforms ^2; the literal version is what works on
		// npm 10 (`$sveltekit-superforms` does not).
		const overrides = (data.overrides ?? {}) as Record<string, unknown>;
		const current = overrides.formsnap;
		if (current !== undefined && (typeof current !== 'object' || current === null)) {
			f.warnings.push(
				`overrides.formsnap is not an object; set "formsnap": { "sveltekit-superforms": "${SUPERFORMS_VERSION}" } by hand`
			);
		} else {
			const formsnap = (current ?? {}) as Record<string, unknown>;
			if (formsnap['sveltekit-superforms'] !== SUPERFORMS_VERSION) {
				data.overrides = {
					...overrides,
					formsnap: { ...formsnap, 'sveltekit-superforms': SUPERFORMS_VERSION }
				};
				changed.push(`overrides formsnap → sveltekit-superforms ${SUPERFORMS_VERSION}`);
			}
		}
	}

	if (changed.length > 0) {
		writeJson(pkgPath, data, indent);
		f.changed = true;
		f.details.push(...changed);
	}
	return f;
}

function depRange(data: PkgJson, name: string): string | undefined {
	return data.devDependencies?.[name] ?? data.dependencies?.[name];
}

/** Packages whose lockfile entries go stale when Kit 3 replaces Kit 2. */
const STALE_LOCK_ENTRY =
	/(^|\/)node_modules\/(@sveltejs\/[^/]+|sveltekit-superforms|sveltekit-flash-message|formsnap|@velastack\/[^/]+|sveltekit-negotiate)$/;

/**
 * Drop the lockfile entries for the packages this migration moves, so the
 * install resolves them afresh. Left in, npm tries to keep Kit 2 alongside
 * Kit 3 and fails with an ERESOLVE that names neither.
 */
function lockfileFixup(root: string): Fixup {
	const f = fixup('package-lock.json');
	const lockPath = path.join(root, 'package-lock.json');
	if (!fs.existsSync(lockPath)) {
		for (const other of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
			if (fs.existsSync(path.join(root, other))) {
				f.warnings.push(
					`${other} still pins SvelteKit 2 packages; if the install fails, update @sveltejs/* with your package manager`
				);
			}
		}
		return f;
	}
	const { data, indent } = readJson(lockPath);
	const packages = data.packages as Record<string, unknown> | undefined;
	const project = readJson(path.join(root, 'package.json')).data;
	// A lockfile still on Kit 2 has every @sveltejs package resolved for it,
	// transitive ones included; on Kit 3 only what package.json moved past.
	const lockedKit = (packages?.['node_modules/@sveltejs/kit'] as { version?: string } | undefined)
		?.version;
	const kit2Lock = lockedKit !== undefined && (minVersion(lockedKit)?.major ?? 0) < 3;
	const removed: string[] = [];
	if (packages) {
		for (const key of Object.keys(packages)) {
			if (!STALE_LOCK_ENTRY.test(key)) continue;
			const name = key.replace(/^.*node_modules\//, '');
			const stale =
				(kit2Lock && name.startsWith('@sveltejs/')) || belowFloor(project, key, packages[key]);
			if (!stale) continue;
			delete packages[key];
			removed.push(name);
		}
	}
	if (removed.length > 0) {
		writeJson(lockPath, data, indent);
		f.changed = true;
		f.details.push(`dropped stale entries for ${[...new Set(removed)].sort().join(', ')}`);
	}
	return f;
}

/** A top-level lock entry for a direct dependency, locked below what package.json now declares. */
function belowFloor(project: PkgJson, key: string, entry: unknown): boolean {
	if (key.indexOf('node_modules/') !== key.lastIndexOf('node_modules/')) return false;
	const name = key.replace(/^node_modules\//, '');
	const range = depRange(project, name);
	const version = (entry as { version?: string } | undefined)?.version;
	if (!range || !version) return false;
	const floor = minVersion(range);
	const locked = minVersion(version);
	return Boolean(floor && locked && compareVersions(locked, floor) < 0);
}

function readJson(file: string): { data: PkgJson; indent: string } {
	const text = fs.readFileSync(file, 'utf8');
	return {
		data: JSON.parse(text) as PkgJson,
		indent: text.match(/^[{[]\s*\n([\t ]+)/)?.[1] ?? '\t'
	};
}

function writeJson(file: string, data: unknown, indent: string): void {
	fs.writeFileSync(file, `${JSON.stringify(data, null, indent)}\n`);
}

/**
 * What a person still has to look at, beyond MIGRATION_TASKS.md: `??`
 * defaults on variables that are now never undefined, ORIGIN, which
 * adapter-node 6 ignores, a literal `paths.origin`, files sv could not parse,
 * and inline `alias` config.
 */
function collectFollowUps(root: string, sv: SvSummary): string[] {
	const items: string[] = [];
	const files = [...sourceFiles(path.join(root, 'src')), ...sourceFiles(path.join(root, 'test'))];

	for (const failure of sv.failures) {
		if (failure.file) {
			items.push(
				`\`${failure.file}\`: sv's \`${failure.task}\` task could not parse it, so sv skipped it (vela rewrote its \`$lib\` imports). Finish it by hand: \`$app/environment\` → \`$app/env\`, \`$env/*\` → named imports from \`$app/env/*\`, hook types from \`@sveltejs/kit/hooks\`.`
			);
		} else {
			items.push(
				`sv's \`${failure.task}\` task failed: ${failure.message}. Run it again with \`npx sv migrate sveltekit-3 --tasks ${failure.task}\` once fixed.`
			);
		}
	}

	for (const file of files) {
		const source = fs.readFileSync(file, 'utf8');
		const rel = path.relative(root, file).split(path.sep).join('/');
		const lines = source.split('\n');

		const locals = envImports(source)
			.filter((i) => !i.local.includes('.'))
			.map((i) => i.local);
		if (locals.length > 0) {
			// `?? ''` repeats what the schema already does; anything else never applies.
			const nullish = new RegExp(
				String.raw`(?<![\w$.])(${locals.map(escape).join('|')})\s*\?\?(?!\s*(?:''|""|\`\`))`
			);
			// The expression, not the line number: formatting moves lines, and a
			// second run has to write the same report.
			const expression = new RegExp(`${nullish.source}\\s*[^,;)}\\]\\n]*`, 'g');
			for (const match of source.matchAll(expression)) {
				items.push(
					`${code(rel)}: ${code(match[0].trim())}. The variable's schema turns a missing value into \`''\`, so \`??\` never applies; use \`||\`.`
				);
			}
		}

		for (const line of lines) {
			if (/(?<![\w$])ORIGIN(?![\w$])/.test(line) && !line.includes(MIGRATION_TASK_MARKER)) {
				items.push(
					`${code(rel)}: ${code(line.trim())}. adapter-node 6 no longer reads \`ORIGIN\`; the origin comes from \`paths.origin\` (baked in at build time) or the request.`
				);
			}
		}
	}

	const vite = inspectViteSveltekit(root);
	if (vite?.inlineArg) {
		const config = vite.inlineArg.getText();
		const rel = path.basename(vite.filePath);
		if (/\borigin\s*:\s*['"`]/.test(config)) {
			items.push(
				`\`${rel}\`: \`paths.origin\` is a literal. It is baked into the build, so every host serving this app gets that origin; leave it unset for a multi-host deploy (vela sets it from VELA_ORIGIN on single-host deploys).`
			);
		}
		if (/\balias\s*:/.test(config)) {
			items.push(
				`\`${rel}\`: the \`alias\` option is deprecated in SvelteKit 3. Move each alias to a package.json \`imports\` entry (\`"#name/*": "./path/*"\`).`
			);
		}
	}
	return items;
}

const SV_FAILURE_ITEM = /sv's `[^`]+` task (could not parse it|failed)/;

/** Items about sv's own failures from the follow-ups an earlier run wrote. */
function previousSvFollowUps(root: string): string[] {
	const file = path.join(root, MIGRATION_TASKS_FILE);
	if (!fs.existsSync(file)) return [];
	const content = fs.readFileSync(file, 'utf8');
	const start = content.indexOf(FOLLOW_UPS_HEADING);
	if (start === -1) return [];
	const end = content.indexOf('\n## ', start + FOLLOW_UPS_HEADING.length);
	return content
		.slice(start, end === -1 ? undefined : end)
		.split('\n')
		.filter((line) => line.startsWith('- [') && SV_FAILURE_ITEM.test(line))
		.map((line) => line.replace(/^- \[[ x]\] /, ''));
}

/** Inline markdown code, fenced with enough backticks for what it holds. */
function code(text: string): string {
	const fence = text.includes('`') ? '``' : '`';
	const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
	return `${fence}${pad}${text}${pad}${fence}`;
}

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Put the follow-ups in MIGRATION_TASKS.md, replacing the section a previous
 * run wrote. Without sv's file there and nothing project-specific to say,
 * no file is created.
 */
function writeFollowUps(root: string, items: string[], generic: string[]): void {
	const file = path.join(root, MIGRATION_TASKS_FILE);
	const exists = fs.existsSync(file);
	const all = [...items, ...generic];
	if (!exists && items.length === 0) return;

	const original = exists ? fs.readFileSync(file, 'utf8') : '# SvelteKit 3 migration tasks\n';
	let content = original;
	const start = content.indexOf(FOLLOW_UPS_HEADING);
	if (start !== -1) {
		const next = content.indexOf('\n## ', start + FOLLOW_UPS_HEADING.length);
		content = content.slice(0, start) + (next === -1 ? '' : content.slice(next + 1));
	}
	if (all.length > 0) {
		const body = [
			FOLLOW_UPS_HEADING,
			'',
			'Found by `vela migrate sveltekit-3` after sv ran. Each is a place to check by hand.',
			'',
			...all.map((item) => `- [ ] ${item}`),
			''
		].join('\n');
		const final = content.indexOf('## Final verification');
		content =
			final === -1
				? `${content.trimEnd()}\n\n${body}`
				: `${content.slice(0, final)}${body}\n${content.slice(final)}`;
	}
	if (content !== original) fs.writeFileSync(file, content);
}

/** The sections and files sv's MIGRATION_TASKS.md lists, and the `@migration-task` comments in the code. */
export function summarizeMigrationTasks(root: string): MigrationTasksSummary | null {
	const file = path.join(root, MIGRATION_TASKS_FILE);
	const markerComments = countMarkers(root);
	if (!fs.existsSync(file))
		return markerComments > 0 ? { sections: [], filesToReview: 0, markerComments } : null;
	const sections: MigrationTasksSummary['sections'] = [];
	let current: { title: string; files: string[] } | null = null;
	let inFiles = false;
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (line.startsWith('## ')) {
			current = null;
			inFiles = false;
		} else if (line.startsWith('### ')) {
			current = { title: line.slice(4).trim(), files: [] };
			sections.push(current);
			inFiles = false;
		} else if (line.startsWith('#### ')) {
			inFiles = line.trim() === '#### Files to review';
		} else if (inFiles && current) {
			const match = line.match(/^- \[[ x]\] `([^`]+)`/);
			if (match) current.files.push(match[1]!);
		}
	}
	const filesToReview = new Set(sections.flatMap((s) => s.files)).size;
	return { sections, filesToReview, markerComments };
}

function countMarkers(root: string): number {
	let count = 0;
	const files = [...sourceFiles(path.join(root, 'src')), ...sourceFiles(path.join(root, 'test'))];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (entry.isFile() && /\.(ts|js|mts|mjs)$/.test(entry.name))
			files.push(path.join(root, entry.name));
	}
	for (const file of files) {
		count += fs.readFileSync(file, 'utf8').split(MIGRATION_TASK_MARKER).length - 1;
	}
	return count;
}

async function install(root: string): Promise<boolean> {
	const agent = (await detect({ cwd: root }))?.name ?? 'npm';
	return installDependencies(agent, root, { exitOnFailure: false });
}

/**
 * The whole project through its own prettier, for a project vela just
 * created from a migrated template: every file is the template's. Best
 * effort, like sv's own formatting step.
 */
export async function formatProject(root: string): Promise<void> {
	const bin = path.join(root, 'node_modules', '.bin', 'prettier');
	if (!fs.existsSync(bin)) return;
	await x(bin, ['--write', '--ignore-unknown', '.'], {
		nodeOptions: { cwd: root, stdio: 'ignore' }
	});
}

/**
 * Run the project's prettier over the files this migration changed (by git,
 * minus those already changed before it ran). Best effort: no git, no
 * prettier, or prettier failing leaves the files as they are.
 */
async function formatChanged(root: string, dirtyBefore: Set<string>): Promise<string[]> {
	const bin = path.join(root, 'node_modules', '.bin', 'prettier');
	const changed = gitDirty(root);
	if (!changed || !fs.existsSync(bin)) return [];
	const files = changed.filter(
		(f) =>
			!dirtyBefore.has(f) &&
			fs.existsSync(path.join(root, f)) &&
			fs.statSync(path.join(root, f)).isFile()
	);
	if (files.length === 0) return [];
	const result = await x(bin, ['--write', '--ignore-unknown', ...files], {
		nodeOptions: { cwd: root, stdio: 'ignore' }
	});
	return result.exitCode === 0 ? files : [];
}
