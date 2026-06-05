import { API_URL } from './constants.ts';

export interface User {
	id: string;
	email: string;
}

export interface Team {
	id: string;
	name: string;
	is_personal: boolean;
	owner: string;
}

export interface ProjectRecord {
	id: string;
	name: string;
	team: string;
	user?: string;
	expand?: { team?: Team };
}

interface PaginatedResponse<T> {
	items: T[];
	page: number;
	perPage: number;
	totalItems: number;
	totalPages: number;
}

async function apiFetch<T>(apiKey: string, pathAndQuery: string, init?: RequestInit): Promise<T> {
	const headers = new Headers(init?.headers);
	headers.set('Authorization', `Bearer ${apiKey}`);
	if (init?.body && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json');
	}

	const res = await fetch(`${API_URL}${pathAndQuery}`, { ...init, headers });
	if (res.status === 401 || res.status === 403) {
		throw new Error('API key invalid — run `vela login`');
	}
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Velastack API error (${res.status}): ${body || res.statusText}`);
	}
	return (await res.json()) as T;
}

export async function getCurrentUser(apiKey: string): Promise<User> {
	const data = await apiFetch<PaginatedResponse<User>>(
		apiKey,
		'/api/collections/users/records?perPage=1'
	);
	const user = data.items[0];
	if (!user) throw new Error('No user found. Run `vela login` to login.');
	return user;
}

export async function listTeams(apiKey: string): Promise<Team[]> {
	const data = await apiFetch<PaginatedResponse<Team>>(
		apiKey,
		'/api/collections/teams/records?perPage=200'
	);
	return data.items;
}

export async function listProjects(apiKey: string): Promise<ProjectRecord[]> {
	const data = await apiFetch<PaginatedResponse<ProjectRecord>>(
		apiKey,
		'/api/collections/projects/records?perPage=200&expand=team'
	);
	return data.items;
}

export async function createProject(
	apiKey: string,
	args: { name: string; teamId: string; userId: string }
): Promise<ProjectRecord> {
	return apiFetch<ProjectRecord>(apiKey, '/api/collections/projects/records', {
		method: 'POST',
		body: JSON.stringify({ name: args.name, team: args.teamId, user: args.userId })
	});
}
