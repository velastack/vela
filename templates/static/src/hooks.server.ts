import { dev } from '$app/environment';
import { error, type Handle } from '@sveltejs/kit';

/** Pages a `vela` command generates, and the command that generates them. */
const GENERATED_PAGES: Record<string, string> = {
	'/privacy': 'vela legal privacy',
	'/terms': 'vela legal terms'
};

/**
 * The footer links to these before they exist. In dev, say which command creates
 * the page instead of showing a bare 404.
 *
 * Server hooks run in dev and at prerender time; a static build has no server, so
 * the `dev` guard also keeps this out of the prerendered output.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);

	if (dev && response.status === 404) {
		const command = GENERATED_PAGES[event.url.pathname];
		if (command) error(404, `Run \`${command}\` to create this page.`);
	}

	return response;
};
