import process from 'node:process';
import { readBinding } from './deploy-config.ts';

/**
 * The public origin a build renders absolute URLs against.
 *
 * Prerendering happens with no request to take an origin from, so SvelteKit
 * substitutes `http://sveltekit-prerender` and every canonical link, `og:url`
 * and `hreflang` baked into a prerendered page points at a host that does not
 * exist. The domain the app is actually served on is already known here — it is
 * the one Caddy is configured with — so the build is told about it and
 * `paths.origin` takes over.
 *
 * Null rather than a guess: an origin invented from a default would be wrong in
 * a way that is invisible until someone reads the shipped HTML, which is exactly
 * the failure this exists to end. Null too for a domain naming several hosts,
 * for the reason `buildOrigin` gives.
 */
export function resolveOrigin(workspaceRootDir: string, envTag: string): string | null {
	// The binding records exactly the hosts Caddy serves directly — what
	// `vela deploy` passed as `--domain` — so it answers "how many" as well as
	// "which".
	const domain = readBinding(workspaceRootDir, envTag)?.domain;
	return buildOrigin(splitHosts(domain), domain, process.env.VELA_ORIGIN);
}

/**
 * The origin to bake into a build as `paths.origin`, or null for none.
 *
 * Under SvelteKit 3 `paths.origin` is not just what prerendered pages render
 * against: it is `url.origin` for every request, and what the CSRF check
 * compares a form post's `Origin` with. One app served directly on several
 * hosts (velastack.dev and velabase.dev) cannot have one — the second host
 * would render as the first and have its form posts refused — so it gets none,
 * and each request takes its origin from `Host` and the `PROTOCOL_HEADER`
 * runtime.env sets. `directHosts` are the hosts Caddy serves itself, the same
 * set `runtime_origin_lines` counts on the server; managed velastack.app names
 * redirect to a direct host at the edge and do not count.
 *
 * An explicit override wins either way, and an empty one is an explicit "none":
 * `vela deploy` hands its decision to `vela build` as `VELA_ORIGIN=`, which must
 * not fall through to the binding's first host.
 */
export function buildOrigin(
	directHosts: readonly string[],
	primaryUrl: string | null | undefined,
	envOverride: string | undefined
): string | null {
	if (envOverride !== undefined) return normalizeOrigin(envOverride);
	if (directHosts.length > 1) return null;
	return normalizeOrigin(primaryUrl);
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

/** The hosts in a `--domain` value, in the order given, trimmed and without blanks. */
export function splitHosts(value: string | null | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((host) => host.trim())
		.filter(Boolean);
}

/** What velastack.dev answered about an environment's hostnames, when it answered. */
export interface AnsweredHostnames {
	managed?: string[];
	direct?: string[];
}

export interface DeployHosts {
	/** Hosts Caddy serves directly. */
	direct: string[];
	/** Managed `<sub>.velastack.app` hosts, reached through the Worker. */
	managed: string[];
	/** The managed hosts were carried over from the server, not confirmed by velastack.dev. */
	keptManaged: boolean;
}

/**
 * The hostnames a deploy activates with.
 *
 * Managed hostnames belong to velastack.dev, and a deploy hears about them only
 * when it has an API key and the call goes through. "No answer" is not "none":
 * a runner without the key, a revoked key or a network failure must not take a
 * live hostname down. So with no answer, the ones the server is already
 * serving stay; only an answer that leaves them out removes them.
 */
export function deployHosts(input: {
	/** The `--domain` value or the recorded one. */
	configured: string | null | undefined;
	/** The environment velastack.dev answered with, or null when it was not asked or did not answer. */
	answered: AnsweredHostnames | null | undefined;
	/** The managed hostname(s) the server has for this instance now. */
	existingManaged: string | null | undefined;
}): DeployHosts {
	const direct = [...new Set([...splitHosts(input.configured), ...(input.answered?.direct ?? [])])];
	if (input.answered) {
		return { direct, managed: input.answered.managed ?? [], keptManaged: false };
	}
	const managed = splitHosts(input.existingManaged);
	return { direct, managed, keptManaged: managed.length > 0 };
}

/**
 * Whether to announce a deploy to velastack.dev when the server could not be
 * identified to it first.
 *
 * velastack.dev gives a managed hostname only to a deploy that names a
 * registered server, and records the environment as having none otherwise. An
 * environment that already has one must not be announced that way: the
 * hostname would be taken away over a failed registration call. Such a deploy
 * goes unrecorded instead, and keeps what the server has.
 */
export function shouldAnnounceDeploy(input: {
	serverIdentified: boolean;
	existingManaged: string | null | undefined;
}): boolean {
	return input.serverIdentified || splitHosts(input.existingManaged).length === 0;
}
