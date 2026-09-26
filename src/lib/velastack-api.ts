import { API_URL } from './constants.ts';

export interface User {
	id: string;
	email: string;
}

export interface Team {
	id: string;
	name: string;
	/** URL segment of the team on velastack.dev. */
	slug: string;
	is_personal: boolean;
	owner: string;
}

export interface ProjectRecord {
	id: string;
	name: string;
	/** URL segment of the project within its team, assigned by velastack.dev. */
	slug: string;
	team: string;
	user?: string;
	/** The registry template the project was created from, when known. */
	template?: string;
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
	if (res.status === 401) {
		throw new Error('API key invalid — run `vela login`');
	}
	if (res.status === 403) {
		const body = await res.text().catch(() => '');
		throw new Error(`velastack.dev refused this key (${body || 'forbidden'}) — run \`vela login\``);
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
	args: { name: string; teamId: string; userId: string; template?: string }
): Promise<ProjectRecord> {
	return apiFetch<ProjectRecord>(apiKey, '/api/collections/projects/records', {
		method: 'POST',
		body: JSON.stringify({
			name: args.name,
			team: args.teamId,
			user: args.userId,
			...(args.template ? { template: args.template } : {})
		})
	});
}

// ------------------------------------------------------------ control plane
//
// `vela deploy` announces itself before building, learns the hostnames the
// environment is served on, and reports how it ended. The env tag is the CLI's
// own instance suffix, so velastack.dev records exactly what the server calls
// the environment.

export interface StartDeploymentInput {
	/** The target as typed: `production`, `staging`, `preview`. */
	target: string;
	env_tag: string;
	branch?: string;
	git_sha?: string;
	kind?: 'app' | 'cms';
	/** Hostnames the CLI already routes on its own: `--domain`, the binding, the config. */
	hostnames?: string[];
	/** The registered server this lands on; without it no managed hostname is claimed. */
	server?: { id: string; token: string };
}

export interface EnvironmentHostnames {
	envTag: string;
	/** `<sub>.velastack.app` names the Worker proxies to this server; Caddy routes them by header. */
	managed: string[];
	/** Managed names that stand aside for a direct one and redirect to it at the edge. */
	redirects: string[];
	/** Names the user's own DNS points at the server, served by Caddy directly. */
	direct: string[];
	/** The origin the app is built and served as; empty when nothing routes to it yet. */
	primaryUrl: string;
}

export interface StartDeploymentResult {
	deploymentId: string;
	environment: EnvironmentHostnames;
}

export interface RegisterServerInput {
	ip: string;
	serverId?: string;
	token?: string;
}

export interface RegisteredServer {
	serverId: string;
	originHost: string;
	token: string;
}

/** Introduce a server, or confirm a known one and refresh its IP. */
export async function registerServer(
	apiKey: string,
	input: RegisterServerInput
): Promise<RegisteredServer> {
	return apiFetch<RegisteredServer>(apiKey, '/v1/servers', {
		method: 'POST',
		body: JSON.stringify(input)
	});
}

export type FinishDeploymentInput =
	{ status: 'deployed'; release?: string; url?: string } | { status: 'failed'; error?: string };

export async function startDeployment(
	apiKey: string,
	projectId: string,
	input: StartDeploymentInput
): Promise<StartDeploymentResult> {
	return apiFetch<StartDeploymentResult>(apiKey, `/v1/projects/${projectId}/deployments`, {
		method: 'POST',
		body: JSON.stringify(input)
	});
}

export async function finishDeployment(
	apiKey: string,
	projectId: string,
	deploymentId: string,
	input: FinishDeploymentInput
): Promise<{ deploymentId: string; status: string }> {
	return apiFetch(apiKey, `/v1/projects/${projectId}/deployments/${deploymentId}`, {
		method: 'PATCH',
		body: JSON.stringify(input)
	});
}

// ------------------------------------------------------------ hosted sites
//
// A site velastack.dev hosts is a prebuilt template copy, so a publish in the
// hosted CMS reaches visitors only once the site is built again. `vela cms
// deploy` asks for that rebuild and watches it; the wire shape is the one the
// admin bar's "Deploy Site…" reads from the CMS's own `/deploy`.

export interface SiteDeployRun {
	id: string;
	status: 'pending' | 'building' | 'deployed' | 'failed';
	createdAt: string;
	finishedAt?: string;
	error?: string;
}

export interface SiteDeployState {
	/** False for a project with no hosted site: one deployed with `vela deploy`, or none at all. */
	available: boolean;
	site?: { url: string };
	latest?: SiteDeployRun | null;
}

export async function getSiteDeploy(apiKey: string, projectId: string): Promise<SiteDeployState> {
	return apiFetch<SiteDeployState>(apiKey, `/v1/projects/${projectId}/site/deploy`);
}

export async function startSiteDeploy(apiKey: string, projectId: string): Promise<SiteDeployState> {
	return apiFetch<SiteDeployState>(apiKey, `/v1/projects/${projectId}/site/deploy`, {
		method: 'POST'
	});
}

/**
 * What `POST /v1/projects/:id/site/seed` did: the template's published
 * content went into the project's CMS, the template published none (its
 * components carry the copy inline), or the project already had content.
 */
export type SiteSeedOutcome =
	| { status: 'seeded'; locales: string[]; layouts: number; pages: number; site: boolean }
	| { status: 'no-content' }
	| { status: 'already-seeded' };

/**
 * Fill a linked project's hosted CMS from its template's content manifest,
 * at the registry version `vela create` unpacked. Every language the template
 * ships is enabled; the owner can drop one from the admin bar.
 */
export async function seedSite(
	apiKey: string,
	projectId: string,
	input: { template: string; version?: string }
): Promise<SiteSeedOutcome> {
	return apiFetch<SiteSeedOutcome>(apiKey, `/v1/projects/${projectId}/site/seed`, {
		method: 'POST',
		body: JSON.stringify(input)
	});
}

export async function destroyEnvironment(
	apiKey: string,
	projectId: string,
	envTag: string
): Promise<{ envTag: string; status: string }> {
	return apiFetch(apiKey, `/v1/projects/${projectId}/environments/${encodeURIComponent(envTag)}`, {
		method: 'DELETE'
	});
}
