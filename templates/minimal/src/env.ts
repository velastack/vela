import { defineEnvVars } from '@sveltejs/kit/env';

/**
 * Every environment variable the app reads. SvelteKit exposes only what is
 * declared here, through `$app/env/private` (and `$app/env/public` for
 * `public: true`).
 *
 * Each schema turns a missing value into `''`, so the app builds and starts
 * with an empty `.env`, and a default belongs at the call site as `X || fallback`.
 */
export const variables = defineEnvVars({
	POCKETBASE_URL: {
		schema: (value) => value ?? '',
		description: 'Where PocketBase listens. `vela dev` and `vela deploy` set it.'
	},
	POCKETBASE_SUPERUSER_EMAIL: {
		schema: (value) => value ?? '',
		description: 'Superuser email the server signs in with for admin features and workflows.'
	},
	POCKETBASE_SUPERUSER_PASSWORD: {
		schema: (value) => value ?? '',
		description: 'Password for POCKETBASE_SUPERUSER_EMAIL.'
	},
	WORKFLOWS_ENABLED: {
		schema: (value) => value ?? '',
		description: 'Set to `false` to stop this process running workflows; it can still start them.'
	},
	WORKFLOWS_CONCURRENCY: {
		schema: (value) => value ?? '',
		description: 'How many workflow runs this process executes at once. Defaults to 5.'
	},
	TEST: {
		schema: (value) => value ?? '',
		description: '`true` under `vela test:server`, which turns off the workflow cron schedules.'
	}
});
