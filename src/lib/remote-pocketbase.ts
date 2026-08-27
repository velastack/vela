import PocketBase from 'pocketbase';
import { findFreePort, authWithRetries } from './pocketbase.ts';
import { readInstanceStates } from './remote.ts';
import { readRemoteEnv } from './remote-env.ts';
import type { SshSession } from './ssh.ts';

export interface RemoteDatabase {
	/** Loopback URL on this machine, forwarded to the instance's PocketBase. */
	url: string;
	email: string;
	password: string;
	close: () => Promise<void>;
}

/**
 * Forward a port to the PocketBase of a deployed instance and hand back the
 * credentials to talk to it.
 *
 * PocketBase listens on the server's loopback only, so the SSH connection that
 * is already open is the way in. The superuser credentials come off the server
 * itself: they are the app's own, and nothing about them has to be known here.
 */
export async function openRemoteDatabase(
	session: SshSession,
	instance: string
): Promise<RemoteDatabase> {
	const [state] = await readInstanceStates(session, instance);
	const pbPort = state?.pbPort;
	if (!pbPort) {
		throw new Error(
			`${instance} has no deployed database yet.\n\n` +
				`Run \`vela deploy\` first — the database is created by the first deploy.`
		);
	}

	const env = await readRemoteEnv(session, instance);
	const email = env.POCKETBASE_SUPERUSER_EMAIL;
	const password = env.POCKETBASE_SUPERUSER_PASSWORD;
	if (!email || !password) {
		throw new Error(
			`${instance} has no PocketBase superuser credentials in its environment.\n\n` +
				`A deploy creates them. Deploy again to repair this instance.`
		);
	}

	const localPort = await findFreePort('127.0.0.1');
	await session.forwardLocalPort(localPort, '127.0.0.1', pbPort);

	return {
		url: `http://127.0.0.1:${localPort}`,
		email,
		password,
		close: () => session.cancelForward(localPort, '127.0.0.1', pbPort)
	};
}

/** Run one piece of work against a deployed instance's database, authenticated. */
export async function withRemotePocketbase<T>(
	session: SshSession,
	instance: string,
	fn: (pb: PocketBase) => Promise<T>
): Promise<T> {
	const db = await openRemoteDatabase(session, instance);
	try {
		const pb = new PocketBase(db.url);
		await authWithRetries(pb, db.email, db.password);
		return await fn(pb);
	} finally {
		await db.close();
	}
}
