import type { ServerInit } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { handlePocketbase } from '@velastack/pocketbase';
import { startWorker } from '$lib/server/workflows';

export const handle = handlePocketbase({
	pocketbaseUrl: env.POCKETBASE_URL,
	superuserEmail: env.POCKETBASE_SUPERUSER_EMAIL,
	superuserPassword: env.POCKETBASE_SUPERUSER_PASSWORD
});

// Runs once when the server starts: executes the workflows in src/lib/workflows.
export const init: ServerInit = () => startWorker();
