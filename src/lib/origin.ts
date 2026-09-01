import process from 'node:process';
import { readBinding, type VelaAppConfig } from './deploy-config.ts';

/**
 * The public origin a build renders absolute URLs against.
 *
 * Prerendering happens with no request to take an origin from, so SvelteKit
 * substitutes `http://sveltekit-prerender` and every canonical link, `og:url`
 * and `hreflang` baked into a prerendered page points at a host that does not
 * exist. The domain the app is actually served on is already known here — it is
 * the one Caddy is configured with — so the build is told about it and
 * `kit.prerender.origin` takes over.
 *
 * Null rather than a guess: an origin invented from a default would be wrong in
 * a way that is invisible until someone reads the shipped HTML, which is exactly
 * the failure this exists to end.
 */
export function resolveOrigin(
	workspaceRootDir: string,
	envTag: string,
	config: VelaAppConfig = {}
): string | null {
	return normalizeOrigin(
		process.env.VELA_ORIGIN ??
			readBinding(workspaceRootDir, envTag)?.domain ??
			config.deploy?.domain
	);
}

/**
 * Turn a configured domain into an origin, or null if it cannot be one.
 *
 * `--domain` takes the comma-separated list Caddy serves, and the first host is
 * the canonical one — the same choice `velastack/action` makes when it reports a
 * deployment's URL. A bare hostname gets `https://`, because that is what Caddy
 * terminates; anything already carrying a scheme is left alone, so a local
 * `http://127.0.0.1:4100` survives.
 */
export function normalizeOrigin(value: string | null | undefined): string | null {
	const first = value?.split(',')[0]?.trim();
	if (!first) return null;

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `https://${first}`;

	try {
		const url = new URL(withScheme);
		// `origin` is scheme + host + non-default port and nothing else, which
		// drops any path, query or trailing slash a hand-written domain carried.
		return url.origin;
	} catch {
		return null;
	}
}
