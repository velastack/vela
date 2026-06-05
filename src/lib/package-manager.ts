import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { exec } from 'tinyexec';
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
		...AGENT_NAMES.map((pm) => ({ value: pm, label: pm }))
	];

	const pm = await p.select({
		message: 'Which package manager do you want to install dependencies with?',
		options,
		initialValue: agent
	});
	if (p.isCancel(pm)) {
		p.cancel('Operation cancelled.');
		process.exit(1);
	}
	return pm;
}

export async function installDependencies(agent: AgentName, cwd: string): Promise<void> {
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
	} catch {
		task.error('Failed to install dependencies');
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
