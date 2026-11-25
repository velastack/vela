import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { exec, execSync } from 'tinyexec';
import { Option } from 'commander';
import * as p from '@clack/prompts';
import { taskLog } from './task-log.ts';
import {
	AGENTS,
	COMMANDS,
	LOCKS,
	constructCommand,
	detect,
	resolveCommand,
	type Agent,
	type AgentName
} from 'package-manager-detector';

export const AGENT_NAMES = AGENTS.filter((agent): agent is AgentName => !agent.includes('@'));

export const installOption = new Option(
	'--install <package-manager>',
	'installs dependencies with a specified package manager'
).choices(AGENT_NAMES);

export function getUserAgent(): AgentName | undefined {
	const userAgent = process.env.npm_config_user_agent;
	if (!userAgent) return undefined;
	const pmSpec = userAgent.split(' ')[0]!;
	const separatorPos = pmSpec.lastIndexOf('/');
	const name = pmSpec.substring(0, separatorPos) as AgentName;
	return AGENTS.includes(name) ? name : undefined;
}

export async function packageManagerPrompt(cwd: string): Promise<AgentName | undefined> {
	const detected = await detect({ cwd });
	const agent = detected?.name ?? getUserAgent();

	if (!process.stdout.isTTY) return agent;

	const options: Array<{ value: AgentName | undefined; label: AgentName | 'None' }> = [
		{ label: 'None', value: undefined },
		...AGENT_NAMES.filter(isInstalled).map((pm) => ({ value: pm, label: pm }))
	];

	const pm = await p.select({
		message: 'Detected package managers. Which one should we use to install dependencies?',
		options,
		initialValue: agent
	});
	if (p.isCancel(pm)) {
		p.cancel('Operation cancelled.');
		process.exit(1);
	}
	return pm;
}

const installedCache = new Map<AgentName, boolean>();

/** Whether `agent` is on the PATH, checked once per process by running `<agent> --version`. */
export function isInstalled(agent: AgentName): boolean {
	let installed = installedCache.get(agent);
	if (installed === undefined) {
		try {
			execSync(agent, ['--version'], { nodeOptions: { stdio: 'ignore' } });
			installed = true;
		} catch {
			installed = false;
		}
		installedCache.set(agent, installed);
	}
	return installed;
}

const NPM_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

/**
 * Whether the lockfile nearest to `cwd` (its own directory, or the closest
 * parent that has any) includes npm's.
 */
function npmLockfileGoverns(cwd: string): boolean {
	let dir = path.resolve(cwd);
	for (;;) {
		if (NPM_LOCKFILES.some((name) => fs.existsSync(path.join(dir, name)))) return true;
		if (Object.keys(LOCKS).some((name) => fs.existsSync(path.join(dir, name)))) return false;
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

/**
 * The package manager to run this project's scripts and installed binaries
 * with. Not the one to install with: that stays whatever the project is pinned
 * by.
 *
 * - npm when there is a `package-lock.json`, whatever else is beside it. The
 *   detector ranks `pnpm-lock.yaml` and `yarn.lock` first, and a project that
 *   carries both (a pnpm project that added npm's lockfile so servers and CI can
 *   `npm ci`) then fails on a machine with only npm: `spawn pnpm ENOENT`.
 * - Otherwise the detected one, when its executable is on the PATH.
 * - Otherwise npm, which every machine with Node has. Running a script does not
 *   need the manager that installed the tree.
 *
 * `installed` is for tests.
 */
export async function scriptAgent(
	cwd: string,
	installed: (agent: AgentName) => boolean = isInstalled
): Promise<Agent> {
	if (npmLockfileGoverns(cwd)) return 'npm';
	const detected = await detect({ cwd });
	if (!detected || detected.name === 'npm') return 'npm';
	return installed(detected.name) ? detected.agent : 'npm';
}

export interface AgentCommand {
	agent: Agent;
	command: string;
	args: string[];
}

/** How to run one of the project's package.json scripts: `npm run build`, `pnpm run build`. */
export async function runScriptCommand(
	cwd: string,
	script: string,
	args: string[] = [],
	installed?: (agent: AgentName) => boolean
): Promise<AgentCommand> {
	const agent = await scriptAgent(cwd, installed);
	const resolved =
		resolveCommand(agent, 'run', [script, ...args]) ??
		resolveCommand('npm', 'run', [script, ...args])!;
	return { agent, command: resolved.command, args: resolved.args };
}

/**
 * How to run a binary the project has installed (`vite`, `vitest`, `wuchale`):
 * `pnpm exec`, `yarn exec` (Yarn 2 and later), `bun x`, and `npx` otherwise.
 *
 * The local form, not `pnpm dlx`/`yarn dlx`: those fetch a copy from the
 * registry at whatever version is latest and never look at the project's
 * `node_modules`. `npx` keeps `--yes`, as it always had here; it runs the
 * installed binary when there is one.
 */
export async function localExecCommand(
	cwd: string,
	args: string[],
	installed?: (agent: AgentName) => boolean
): Promise<AgentCommand> {
	const agent = await scriptAgent(cwd, installed);
	// Everything else goes through npx, which reads node_modules/.bin whoever
	// wrote it. Yarn 1 in particular: its `yarn exec` wants the binary's own
	// arguments behind a `--`, which the binary then receives as well.
	const own = /^(pnpm|bun|yarn@berry)(@|$)/.test(agent)
		? resolveCommand(agent, 'execute-local', args)
		: null;
	const resolved = own ?? { command: 'npx', args };
	return {
		agent,
		command: resolved.command,
		args: resolved.command === 'npx' ? ['--yes', ...resolved.args] : resolved.args.slice()
	};
}

/**
 * Run the package manager's install in `cwd`.
 *
 * Scaffolding commands have nothing to offer once an install fails, so by
 * default this ends the process. A command that can still say something useful
 * - `vela deploy` has already changed the project and can name what to run -
 * passes `exitOnFailure: false` and gets `false` back instead.
 *
 * A package manager that isn't installed is skipped with a warning rather than
 * failed: this returns `false` and the caller leaves the install to the user.
 */
export async function installDependencies(
	agent: AgentName,
	cwd: string,
	{ exitOnFailure = true }: { exitOnFailure?: boolean } = {}
): Promise<boolean> {
	if (!isInstalled(agent)) {
		p.log.warn(`${agent} is not installed, skipping dependency installation.`);
		return false;
	}

	const task = taskLog({
		title: `Installing dependencies with ${agent}...`,
		halfScreen: true,
		spacing: 0,
		retainLog: true
	});

	try {
		const { command, args } = constructCommand(COMMANDS[agent].install, [])!;
		const proc = exec(command, args, {
			nodeOptions: { cwd, stdio: 'pipe' },
			throwOnError: true
		});

		proc.process?.stdout?.on('data', (data) => task.message(data.toString(), { raw: true }));
		proc.process?.stderr?.on('data', (data) => task.message(data.toString(), { raw: true }));

		await proc;
		task.success('Successfully installed dependencies');
		return true;
	} catch {
		task.error('Failed to install dependencies');
		if (!exitOnFailure) return false;
		p.cancel('Operation failed.');
		process.exit(2);
	}
}

export function addPnpmBuildDependencies(
	cwd: string,
	packageManager: AgentName | null | undefined,
	allowedPackages: string[]
) {
	if (!packageManager || packageManager !== 'pnpm') return;

	const pkgPath = path.join(cwd, 'package.json');
	if (!fs.existsSync(pkgPath)) return;

	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
	pkg.pnpm ??= {};
	pkg.pnpm.onlyBuiltDependencies ??= [];
	for (const name of allowedPackages) {
		if (!pkg.pnpm.onlyBuiltDependencies.includes(name)) {
			pkg.pnpm.onlyBuiltDependencies.push(name);
		}
	}
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
}
