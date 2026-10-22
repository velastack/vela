import process from 'node:process';
import pc from 'picocolors';
import { hasBackend } from './workspace.ts';

/**
 * Without PocketBase there are no credentials to ask for. The project may be
 * vela's static template or one vela did not create, so the message names
 * neither, and points at the command that adds only the backend.
 */
export function missingBackendMessage(command: string): string {
	return (
		`${pc.cyan(command)} needs a backend, and this project does not have one.\n\n` +
		`There is no PocketBase database here for it to talk to.\n\n` +
		`To add one, run ${pc.cyan('vela enable backend')}.`
	);
}

export function missingCredentialsMessage(): string {
	return (
		`PocketBase superuser credentials are required.\n\n` +
		`Set ${pc.cyan('POCKETBASE_SUPERUSER_EMAIL')} and ${pc.cyan('POCKETBASE_SUPERUSER_PASSWORD')} in your .env file.\n\n` +
		`To set up a new project, run ${pc.cyan('vela create')}.\n` +
		`To set up an existing project, run ${pc.cyan('vela bless')}.`
	);
}

export function hasSuperuserCredentials(): boolean {
	return Boolean(
		process.env.POCKETBASE_SUPERUSER_EMAIL && process.env.POCKETBASE_SUPERUSER_PASSWORD
	);
}

/**
 * The `preAction` backend gate, for a command that only knows whether it
 * needs PocketBase once it has resolved its provider (`vela enable payments`
 * on Stripe does, on Shopify it doesn't).
 */
export function assertBackendReady(command: string): void {
	if (!hasBackend()) throw new Error(missingBackendMessage(command));
	if (!hasSuperuserCredentials()) throw new Error(missingCredentialsMessage());
}
