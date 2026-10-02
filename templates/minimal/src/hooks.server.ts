import type { ServerInit } from '@sveltejs/kit/hooks';
import {
	POCKETBASE_URL,
	POCKETBASE_SUPERUSER_EMAIL,
	POCKETBASE_SUPERUSER_PASSWORD
} from '$app/env/private';
import { handlePocketbase } from '@velastack/pocketbase';
import { startWorker } from '#lib/server/workflows.js';

export const handle = handlePocketbase({
	pocketbaseUrl: POCKETBASE_URL,
	superuserEmail: POCKETBASE_SUPERUSER_EMAIL,
	superuserPassword: POCKETBASE_SUPERUSER_PASSWORD
});

// Runs once when the server starts: executes the workflows in src/lib/workflows.
export const init: ServerInit = () => startWorker();
