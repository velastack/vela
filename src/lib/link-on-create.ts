import { API_URL } from './constants.ts';

/**
 * Whether `vela create` links the new project to velastack.dev, and how.
 *
 * Pure so every branch is testable without a terminal; the prompts and the
 * network live in `link-project.ts` and the command. The rule of thumb: at a
 * terminal, a logged-in user gets a linked project without being asked; off a
 * terminal nothing is created remotely unless a flag says so.
 */

export const FREE_CMS_HINT = 'Get a free CMS at https://velastack.dev';

/** A PocketBase record id, which is what `--link <project-id>` takes. */
export const PROJECT_ID_RE = /^[a-z0-9]{15}$/;

/** The shape `--cms <url>` and the CMS prompt accept. */
export const CMS_URL_RE = /^https?:\/\/\S+$/;

export const NOT_LOGGED_IN = 'Not logged in. Run `vela login` to login, or set VELA_API_KEY.';

const NO_CMS_WARNING =
	'No CMS configured: `cmsEndpoint` in src/lib/site.ts is empty, so the site shows its ' +
	'fallback copy. Pass `--link new`, `--link <project-id>` or `--cms <url>` to set it, or ' +
	`fill it in later. ${FREE_CMS_HINT}.`;

export type LinkChoice =
	/** Create a project on velastack.dev with the current key. */
	| { kind: 'create' }
	/** Link an existing project by id. */
	| { kind: 'existing'; projectId: string }
	/** Interactive only: run the login flow, then create. */
	| { kind: 'login-then-create' }
	/** Leave the project unlinked; `warn` is printed when that leaves a CMS template blind. */
	| { kind: 'none'; warn?: string };

export type LinkDecision =
	| LinkChoice
	/** Interactive only: ask where the CMS is (log in / URL / skip). */
	| { kind: 'prompt-cms' }
	| { kind: 'error'; message: string };

export interface LinkRequest {
	/** `--link` as typed, already validated: `new`, `none` or a project id. */
	link?: string;
	/** The template reads from a CMS and nothing has named one yet (`--cms` unset). */
	needsCms: boolean;
	loggedIn: boolean;
	interactive: boolean;
}

export function decideLink(request: LinkRequest): LinkDecision {
	const { link, needsCms, loggedIn, interactive } = request;

	if (link === 'none') return { kind: 'none' };
	if (link === 'new') {
		return loggedIn ? { kind: 'create' } : { kind: 'error', message: NOT_LOGGED_IN };
	}
	if (link !== undefined) {
		return loggedIn
			? { kind: 'existing', projectId: link }
			: { kind: 'error', message: NOT_LOGGED_IN };
	}

	// Nothing asked for. Off a terminal, never create remote state on a guess:
	// a CI job holding a deploy key must not mint a project per run.
	if (!interactive) return { kind: 'none', warn: needsCms ? NO_CMS_WARNING : undefined };
	if (loggedIn) return { kind: 'create' };
	return needsCms ? { kind: 'prompt-cms' } : { kind: 'none' };
}

/** The hosted CMS of a velastack.dev project, as `vela enable cms --endpoint` takes it. */
export function cmsEndpointFor(projectId: string): string {
	return `${API_URL}/v1/projects/${projectId}/cms`;
}

/** `--cms <url>` as the site stores it: trimmed, no trailing slash. */
export function normalizeCmsUrl(url: string): string {
	return url.trim().replace(/\/+$/, '');
}

export interface LinkedProject {
	projectId: string;
	teamId: string;
	projectName: string;
	/** The project's page on velastack.dev. */
	dashboardUrl: string;
}

export interface CreateLinkOutcome {
	linked?: LinkedProject;
	/** What went into `site.cmsEndpoint`; empty when nothing did. */
	cmsEndpoint: string;
	/** Where the endpoint came from. */
	cmsSource: 'linked' | 'flag' | 'prompt' | 'none';
	templateCms: boolean;
	loggedIn: boolean;
	interactive: boolean;
}

/** What `vela create` tells the user to do next about the link and the CMS. */
export function linkNextSteps(outcome: CreateLinkOutcome): string[] {
	const steps: string[] = [];
	const { linked, cmsEndpoint, cmsSource, templateCms, loggedIn, interactive } = outcome;

	if (templateCms && linked && cmsSource === 'linked') {
		steps.push(
			`Add an editor at ${linked.dashboardUrl}/cms/editors, then open any page with \`?edit\` and sign in from the admin bar.`
		);
	} else if (cmsEndpoint) {
		steps.push('Open any page with `?edit` and sign in from the admin bar.');
	} else if (templateCms) {
		steps.push(
			`When you have a CMS, set \`cmsEndpoint\` in \`src/lib/site.ts\`. ${FREE_CMS_HINT}.`
		);
	}

	if (linked && !(templateCms && cmsSource === 'linked')) {
		steps.push(
			`Run \`vela deploy\` when you're ready; the project is linked to ${linked.dashboardUrl}.`
		);
	} else if (!linked && interactive && !loggedIn && !templateCms) {
		steps.push('Run `vela login` then `vela link` to get a free velastack.app hostname on deploy.');
	}

	return steps;
}
