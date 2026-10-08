import fs from 'node:fs';
import path from 'node:path';
import { readLocalEnvFile, type EnvRecord } from './remote-env.ts';
import { staticEnvImports } from './static-env.ts';

/**
 * Keys a build against a throwaway local database needs from the developer's
 * `.env`, so they are never blanked when there is no tunnel to supply them.
 */
const LOCAL_BUILD_KEYS =
	/^(POCKETBASE_URL|POCKETBASE_SUPERUSER_EMAIL|POCKETBASE_SUPERUSER_PASSWORD|VELA_)/;

export class DevOnlyEnvError extends Error {}

export interface BuildStackInput {
	/** The target's resolved layers, secret and public, as the server will see them. */
	stack: EnvRecord;
	/** What vela derives for this build: VELA_ORIGIN, the tunnel's PocketBase. */
	derived: Record<string, string | undefined>;
	/** Whether the build renders against the target's database rather than a local one. */
	tunnel: boolean;
}

export interface BuildStack {
	env: Record<string, string | undefined>;
	/** `.env` keys the target does not have, blanked so the build cannot see them. */
	blanked: string[];
}

/**
 * The env a build child runs with: the target's stack, what vela derives, and
 * every key the developer's `.env` has that the target does not — set to the
 * empty string.
 *
 * Vite's `loadEnv` lets a key already in `process.env` win over the files, and
 * SvelteKit reads `.env` from the project root at build whatever vela does, so
 * blanking is how a dev-only value is kept out of a production bundle. Without
 * it, a `$env/static` import that production has no value for would be baked
 * with the developer's, which is the quietest wrong a deploy can be.
 */
export function buildStack(root: string, input: BuildStackInput): BuildStack {
	const env: Record<string, string | undefined> = { ...input.stack, ...input.derived };
	const blanked: string[] = [];

	const file = path.join(root, '.env');
	const local = fs.existsSync(file) ? readLocalEnvFile(file) : {};
	for (const key of Object.keys(local)) {
		if (key in env) continue;
		if (!input.tunnel && LOCAL_BUILD_KEYS.test(key)) continue;
		env[key] = '';
		blanked.push(key);
	}

	// A static import of a blanked key gets '' where the target's build would have
	// failed outright. Fail here instead, before anything is built or uploaded.
	const imports = staticEnvImports(root);
	const baked = blanked.filter((key) => imports.has(key));
	if (baked.length > 0) {
		throw new DevOnlyEnvError(
			`${baked.join(', ')} ${baked.length === 1 ? 'is' : 'are'} imported from $env/static but set only in your .env.\n\n` +
				`The build would bake in your development value. Set ${baked.length === 1 ? 'it' : 'them'} for the target\n` +
				`(vela env set KEY -t <target>) or remove the import.`
		);
	}

	return { env, blanked: blanked.sort() };
}
