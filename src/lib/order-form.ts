/**
 * The hosted VelaStack form that WhatsApp orders are recorded to, so an order
 * is kept even when the customer never sends the chat. `vela enable payments
 * --provider whatsapp` creates it on the linked project and writes its URL to
 * `PUBLIC_WHATSAPP_ORDER_FORM`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { API_URL } from './constants.ts';
import { readApiKey } from './config.ts';
import { readProjectConfig } from './project-config.ts';
import { ApiError, createProjectForms } from './velastack-api.ts';

export const ORDER_FORM_KEY = 'order';
export const ORDER_FORM_NAME = 'Orders';

const HOSTED_CMS = /^(https?:\/\/[^/]+)\/v1\/projects\/([^/?#]+)\/cms\/?$/;

/**
 * The project a hosted CMS endpoint belongs to, from the literal
 * `vela enable cms --endpoint` writes into `src/lib/cms.ts`.
 */
export function hostedCmsProject(root: string): { origin: string; projectId: string } | null {
	let source: string;
	try {
		source = fs.readFileSync(path.join(root, 'src', 'lib', 'cms.ts'), 'utf8');
	} catch {
		return null;
	}
	const endpoint = /\bendpoint:\s*['"]([^'"]+)['"]/.exec(source)?.[1];
	const match = endpoint ? HOSTED_CMS.exec(endpoint) : null;
	return match ? { origin: match[1], projectId: match[2] } : null;
}

export function orderFormUrl(origin: string, projectId: string): string {
	return `${origin}/v1/projects/${projectId}/forms/${ORDER_FORM_KEY}`;
}

export type OrderFormOutcome =
	/** `note`, when the project limits which sites may post to its forms. */
	{ kind: 'created'; url: string; note?: string } | { kind: 'skipped'; note: string };

interface Deps {
	readApiKey: () => string | null;
	createForms: typeof createProjectForms;
}

/**
 * Creates the `order` form on the project this one is linked to (or whose
 * hosted CMS it reads), and gives its URL. Never throws: without a project,
 * a login or a velastack.dev that can do it, the outcome says what to do
 * instead, and checkout still opens the chat, only without recording.
 */
export async function ensureOrderForm(
	root: string,
	deps: Deps = { readApiKey, createForms: createProjectForms }
): Promise<OrderFormOutcome> {
	const linked = readProjectConfig(root);
	const project = linked
		? { origin: API_URL, projectId: linked.projectId }
		: hostedCmsProject(root);
	if (!project) {
		return {
			kind: 'skipped',
			note: 'Orders are not recorded until PUBLIC_WHATSAPP_ORDER_FORM is set: link the project to velastack.dev (`vela link`), then run `vela enable payments --provider whatsapp` again.'
		};
	}
	const apiKey = deps.readApiKey();
	if (!apiKey) {
		return {
			kind: 'skipped',
			note: 'Orders are not recorded until PUBLIC_WHATSAPP_ORDER_FORM is set: run `vela login`, then `vela enable payments --provider whatsapp` again.'
		};
	}
	let origins: string[];
	try {
		({ origins = [] } = await deps.createForms(apiKey, project.projectId, [
			{ key: ORDER_FORM_KEY, name: ORDER_FORM_NAME }
		]));
	} catch (error) {
		const reason =
			error instanceof ApiError ? `velastack.dev answered ${error.status}` : String(error);
		return {
			kind: 'skipped',
			note: `Could not create the hosted order form (${reason}). Add a form keyed "${ORDER_FORM_KEY}" to the project on velastack.dev, then set PUBLIC_WHATSAPP_ORDER_FORM=${orderFormUrl(project.origin, project.projectId)}.`
		};
	}
	const url = orderFormUrl(project.origin, project.projectId);
	// Deployed environments are added to the list on their own; a site served
	// from anywhere else is refused until it is added.
	return origins.length > 0
		? {
				kind: 'created',
				url,
				note: `The project's forms accept posts only from ${origins.join(', ')} (and localhost). If the site is served from another domain, add it on velastack.dev, or its orders are refused.`
			}
		: { kind: 'created', url };
}
