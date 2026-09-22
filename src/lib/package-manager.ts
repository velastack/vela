import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { exec, execSync } from 'tinyexec';
import { Option } from 'commander';
import * as p from '@clack/prompts';
import {
	AGENTS,
	COMMANDS,
	constructCommand,
	detect,
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

	const task = p.taskLog({
		title: `Installing dependencies with ${agent}...`,
		limit: Math.ceil(process.stdout.rows / 2),
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
