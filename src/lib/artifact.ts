import fs from 'node:fs';
import path from 'node:path';
import { spawnCapture } from './ssh.ts';
import { DATA_DIR, MIGRATIONS_DIR } from './constants.ts';
import { runScriptCommand } from './package-manager.ts';

export const DEFAULT_OUTPUT_DIR = 'build';

/** One entry in the release: a local path, and where it lands in the release. */
export interface ArtifactEntry {
	localPath: string;
	/** Remote subdirectory, or '' for the release root. */
	remoteDir: string;
}

export class BuildError extends Error {}

/**
 * Run the project's build. Defaults to the package manager's `build` script,
 * which in a vela project is `vela build` — the same command used locally, so
 * what ships is what was tested.
 */
export async function runBuild(
	cwd: string,
	buildCommand?: string,
	env?: Record<string, string | undefined>
): Promise<void> {
	if (buildCommand) {
		const result = await spawnCapture('bash', ['-lc', buildCommand], {
			cwd,
			stream: true,
			streamStdout: true,
			env
		});
		if (result.exitCode !== 0)
			throw new BuildError(`\`${buildCommand}\` exited ${result.exitCode}.`);
		return;
	}

	const resolved = await runScriptCommand(cwd, 'build');
	const result = await spawnCapture(resolved.command, resolved.args, {
		cwd,
		stream: true,
		streamStdout: true,
		env
	});
	if (result.exitCode !== 0) {
		throw new BuildError(
			`\`${resolved.command} ${resolved.args.join(' ')}\` exited ${result.exitCode}.`
		);
	}
}

/**
 * Work out what goes into a release.
 *
 * The adapter output plus what PocketBase needs at runtime — nothing else. No
 * source, no dev dependencies, and deliberately no `.env`: production
 * environment lives on the server and is managed only by `vela env`.
 */
export function collectArtifact(cwd: string): ArtifactEntry[] {
	const outputDir = DEFAULT_OUTPUT_DIR;
	const entries: ArtifactEntry[] = [];
	const add = (rel: string, remoteDir = '') => {
		const localPath = path.join(cwd, rel);
		if (fs.existsSync(localPath)) entries.push({ localPath, remoteDir });
	};

	const buildPath = path.join(cwd, outputDir);
	if (!fs.existsSync(path.join(buildPath, 'index.js'))) {
		throw new BuildError(
			`No ${outputDir}/index.js to deploy.\n\n` +
				`Deploying to a server needs the output of @sveltejs/adapter-node. Check that the\n` +
				`build ran with it as the adapter, then deploy again.`
		);
	}
	entries.push({ localPath: buildPath, remoteDir: '' });

	add('package.json');
	for (const lockfile of [NPM_LOCKFILE, ...FOREIGN_LOCKFILES]) add(lockfile);
	add('.npmrc');
	add(MIGRATIONS_DIR);
	// PocketBase hooks live under `data/` locally but next to the release on the
	// server, where `data/` is the instance's private database directory.
	const hooks = path.join(cwd, DATA_DIR, 'hooks');
	if (fs.existsSync(hooks)) entries.push({ localPath: hooks, remoteDir: 'hooks' });

	return entries;
}

const NPM_LOCKFILE = 'package-lock.json';

/**
 * Lockfiles of the other package managers. The server installs with npm, which
 * cannot replay them, but they still ship: the dependency cache is keyed on
 * the lockfile, so a change to one has to reach the server to mean anything,
 * and npm does take resolution hints from a `yarn.lock`.
 */
const FOREIGN_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

export function hasLockfile(cwd: string): boolean {
	return fs.existsSync(path.join(cwd, NPM_LOCKFILE));
}

/**
 * The lockfile of a project that pins its dependencies with something other
 * than npm, or undefined when `npm ci` on the server will reproduce the tree
 * (or there is no lockfile at all).
 */
export function foreignLockfile(cwd: string): string | undefined {
	if (hasLockfile(cwd)) return undefined;
	return FOREIGN_LOCKFILES.find((name) => fs.existsSync(path.join(cwd, name)));
}

/**
 * Whether the server has anything to install for this project. Mirrors
 * `package_without_runtime_deps` in templates/server/lib.sh: `dependencies`,
 * `optionalDependencies` and `peerDependencies` (npm installs a project's own
 * peers), empty objects counting as none, and `workspaces` left to npm. A
 * package.json that cannot be read counts as having some, as it does there.
 */
export function hasRuntimeDependencies(cwd: string): boolean {
	let pkg: Record<string, unknown>;
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
	} catch {
		return true;
	}
	const some = (value: unknown) =>
		value != null && typeof value === 'object' && Object.keys(value).length > 0;
	return (
		some(pkg.dependencies) ||
		some(pkg.optionalDependencies) ||
		some(pkg.peerDependencies) ||
		pkg.workspaces != null
	);
}

/** Generates a package-lock.json away from the project's node_modules. */
export const WRITE_LOCKFILE_COMMAND =
	'dir=$(mktemp -d) && cp package.json "$dir" && (cd "$dir" && npm install --package-lock-only --ignore-scripts) && cp "$dir/package-lock.json" .';

/**
 * What `vela deploy` says about a project pinned by pnpm, yarn or bun, or
 * undefined when there is nothing to say: npm's lockfile is there, there is no
 * lockfile, or the server installs nothing for this app (a scaffolded app has
 * only devDependencies, and those never reach the server).
 */
export function lockfileAdvice(cwd: string): string | undefined {
	const foreign = foreignLockfile(cwd);
	if (!foreign || !hasRuntimeDependencies(cwd)) return undefined;
	return (
		`Dependencies are pinned by ${foreign}, which the server cannot replay: it installs with npm.\n` +
		`At deploy time npm resolves this app's runtime dependencies (\`dependencies\` in package.json;\n` +
		`devDependencies are never installed there) from their ranges, so versions may differ from yours.\n` +
		`A committed package-lock.json makes that reproducible. \`npm install --package-lock-only\` fails\n` +
		`inside a node_modules another package manager laid out, so generate it from a clean copy:\n\n` +
		`  ${WRITE_LOCKFILE_COMMAND}\n\n` +
		`Run it again whenever dependencies change. With a package-lock.json present, vela runs the\n` +
		`project's scripts with npm.`
	);
}

/** Best-effort git metadata, recorded on the release for traceability. */
export async function gitSha(cwd: string): Promise<string> {
	const result = await spawnCapture('git', ['rev-parse', 'HEAD'], { cwd });
	return result.exitCode === 0 ? result.stdout.trim() : '';
}

/** The branch checked out here — what a bare `-t preview` is a preview of. */
export async function currentBranch(cwd: string): Promise<string> {
	const result = await spawnCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
	const branch = result.exitCode === 0 ? result.stdout.trim() : '';
	if (!branch || branch === 'HEAD') {
		throw new Error(
			`No branch is checked out here${branch === 'HEAD' ? ' (detached HEAD)' : ''}, so ` +
				'`-t preview` has nothing to name.\n\nName it: `-t preview:<branch>`.'
		);
	}
	return branch;
}
