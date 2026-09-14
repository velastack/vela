import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { requireApiKey } from '../lib/config.ts';
import { getWorkspace } from '../lib/workspace.ts';
import { readPackageJson } from '../lib/package-json.ts';
import { readProjectConfig, writeProjectConfig } from '../lib/project-config.ts';
import { listProjects, listTeams, type ProjectRecord } from '../lib/velastack-api.ts';
import { linkNewProject, pickTeam, toLinked } from '../lib/link-project.ts';

const CREATE_NEW = '__new__';

export const link = new Command('link')
	.description('link this project to a velastack.dev project')
	.configureHelp(helpConfig)
	.action(() => runCommand(linkProject, 'Failed to link the project.'));

async function linkProject() {
	const { workspaceRootDir } = await getWorkspace();

	const existing = readProjectConfig(workspaceRootDir);
	if (existing) {
		p.log.success(`Linked to ${existing.projectName}.`);
		return;
	}

	const apiKey = requireApiKey();
	const [teams, projects] = await Promise.all([listTeams(apiKey), listProjects(apiKey)]);

	const picked = projects.length > 0 ? await pickExistingProject(projects) : CREATE_NEW;
	let linked;
	if (picked !== CREATE_NEW) {
		const project = projects.find((pr) => pr.id === picked)!;
		linked = toLinked(project, project.expand?.team);
	} else {
		const team = await pickTeam(teams);
		const name = await promptProjectName(workspaceRootDir);
		linked = await linkNewProject(apiKey, { name, teamId: team.id, interactive: true });
	}

	const { projectId, teamId, projectName } = linked;
	writeProjectConfig(workspaceRootDir, { projectId, teamId, projectName });
	p.log.success(`Linked to ${projectName} (${linked.dashboardUrl}).`);
}

async function pickExistingProject(projects: ProjectRecord[]): Promise<string> {
	const choice = await p.select({
		message: 'Select a project',
		options: [
			...projects.map((pr) => ({
				value: pr.id,
				label: `${pr.name} (${pr.expand?.team?.name ?? 'unknown team'})`
			})),
			{ value: CREATE_NEW, label: 'Create a new project' }
		]
	});
	if (p.isCancel(choice)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return choice;
}

async function promptProjectName(workspaceRootDir: string): Promise<string> {
	const defaultValue = defaultProjectName(workspaceRootDir);
	const value = await p.text({
		message: 'Project name',
		defaultValue,
		initialValue: defaultValue,
		placeholder: defaultValue,
		validate: (v) => (!v?.trim() ? 'Required' : undefined)
	});
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return value.trim();
}

function defaultProjectName(workspaceRootDir: string): string {
	try {
		const pkg = readPackageJson(path.join(workspaceRootDir, 'package.json'));
		const name = pkg.name;
		if (typeof name === 'string' && name.trim()) return name.trim();
	} catch {
		// fall through
	}
	return path.basename(workspaceRootDir);
}
