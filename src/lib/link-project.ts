import process from 'node:process';
import * as p from '@clack/prompts';
import { API_URL } from './constants.ts';
import type { LinkedProject } from './link-on-create.ts';
import {
	createProject,
	getCurrentUser,
	listProjects,
	listTeams,
	type ProjectRecord,
	type Team
} from './velastack-api.ts';

/**
 * Creating or choosing the velastack.dev project a local one is linked to.
 * Shared by `vela link` and `vela create`, so both record the same thing in
 * `.vela/project.json` and print the same dashboard URL.
 */

export function dashboardUrl(
	teamSlug: string | undefined,
	projectSlug: string | undefined
): string {
	return teamSlug && projectSlug ? `${API_URL}/${teamSlug}/${projectSlug}` : API_URL;
}

export async function pickTeam(teams: Team[]): Promise<Team> {
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

/**
 * The team a new project goes into: `--team` when given, else the personal
 * team, else a choice at a terminal. Off a terminal with no personal team there
 * is nothing sensible to guess, so the flag is required.
 */
export async function resolveTeam(
	teams: Team[],
	options: { teamId?: string; interactive: boolean }
): Promise<Team> {
	if (options.teamId) {
		const team = teams.find((candidate) => candidate.id === options.teamId);
		if (!team) {
			throw new Error(
				`You are not a member of team ${options.teamId}. Omit --team to use your personal team.`
			);
		}
		return team;
	}
	if (teams.length === 0) throw new Error('No team found on velastack.dev for this account.');
	const personal = teams.find((team) => team.is_personal);
	if (personal) return personal;
	if (options.interactive) return pickTeam(teams);
	throw new Error('Several teams and no personal one: pass --team <id>.');
}

export async function linkNewProject(
	apiKey: string,
	args: { name: string; template?: string; teamId?: string; interactive: boolean }
): Promise<LinkedProject> {
	const [user, teams] = await Promise.all([getCurrentUser(apiKey), listTeams(apiKey)]);
	const team = await resolveTeam(teams, { teamId: args.teamId, interactive: args.interactive });
	const project = await createProject(apiKey, {
		name: args.name,
		teamId: team.id,
		userId: user.id,
		template: args.template
	});
	return toLinked(project, team);
}

export async function linkExistingProject(
	apiKey: string,
	projectId: string
): Promise<LinkedProject> {
	const projects = await listProjects(apiKey);
	const project = projects.find((candidate) => candidate.id === projectId);
	if (!project) {
		throw new Error(`No project ${projectId} on velastack.dev for this account.`);
	}
	return toLinked(project, project.expand?.team);
}

export function toLinked(project: ProjectRecord, team: Team | undefined): LinkedProject {
	return {
		projectId: project.id,
		teamId: project.team,
		projectName: project.name,
		dashboardUrl: dashboardUrl(team?.slug, project.slug)
	};
}
