import { localDataDir } from './workspace.ts';

/**
 * The environment a build needs beyond whatever the shell already provides.
 *
 * Gathered in one named place rather than set inline at the top of the command,
 * because that is how `VITE_BUILD` was lost: a refactor changed the action's
 * signature and took the assignment with it, and nothing failed until a
 * prerendered page 500'd on a deploy days later.
 */
export function applyBuildEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
	// `@velastack/pocketbase` reads this to point its admin client straight at
	// PocketBase for the duration of the build. Without it the client keeps its
	// default relative base, so a prerendered page calls back into the app's own
	// admin proxy — which reads `url.search`, something SvelteKit forbids on a
	// prerendered page. The build then fails as an opaque `[500] GET /`.
	env.VITE_BUILD = 'true';

	// Every other context reads the data directory out of the environment, so the
	// one this machine uses has to be there too — otherwise the fallback is the
	// only code path local development ever exercises. An explicit value wins.
	env.VELA_DATA_DIR ??= localDataDir(cwd);
}
