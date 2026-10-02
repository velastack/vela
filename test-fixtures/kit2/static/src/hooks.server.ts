import { handleStatic } from '@velastack/kit';

/**
 * The footer links to `/privacy` and `/terms` before they exist. In dev, this
 * answers a 404 there with the `vela legal` command that creates the page
 * instead of a bare "page not found".
 *
 * A static build has no server, so nothing here reaches the deployed site.
 */
export const handle = handleStatic();
