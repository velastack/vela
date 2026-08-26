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
import {
	createProject,
	getCurrentUser,
	listProjects,
	listTeams,
	type ProjectRecord,
	type Team
} from '../lib/velastack-api.ts';

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
	const [user, teams, projects] = await Promise.all([
		getCurrentUser(apiKey),
		listTeams(apiKey),
		listProjects(apiKey)
	]);

	let projectId: string;
	let teamId: string;
	let projectName: string;

	const picked = projects.length > 0 ? await pickExistingProject(projects) : CREATE_NEW;
	if (picked !== CREATE_NEW) {
		const project = projects.find((pr) => pr.id === picked)!;
		projectId = project.id;
		teamId = project.team;
		projectName = project.name;
	} else {
		const team = await pickTeam(teams);
		const name = await promptProjectName(workspaceRootDir);
		const created = await createProject(apiKey, { name, teamId: team.id, userId: user.id });
		projectId = created.id;
		teamId = team.id;
		projectName = created.name;
	}

	writeProjectConfig(workspaceRootDir, { projectId, teamId, projectName });
	p.log.success(`Linked to ${projectName}.`);
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

async function pickTeam(teams: Team[]): Promise<Team> {
	if (teams.length === 1) return teams[0]!;
	const choice = await p.select({
		message: 'Select a team',
		options: teams.map((team) => ({
			value: team.id,
			label: team.is_personal ? `${team.name} (personal)` : team.name
		}))
	});
	if (p.isCancel(choice)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	return teams.find((team) => team.id === choice)!;
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
