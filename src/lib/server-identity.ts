import * as p from '@clack/prompts';
import pc from 'picocolors';
import { API_URL } from './constants.ts';
import {
	readServerIdentity,
	runServerScript,
	writeServerIdentity,
	type ServerIdentity
} from './remote.ts';
import type { SshSession } from './ssh.ts';
import { registerServer } from './velastack-api.ts';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Make sure the server is registered with velastack.dev and serving its origin
 * site, and return the identity the deploy presents.
 *
 * The identity lives in `/etc/vela/origin.json` on the server, so every
 * project deploying there — from any machine — presents the same one. It is
 * re-confirmed on each deploy, which is also how a changed public IP reaches
 * the DNS record. A row that velastack.dev no longer knows is re-registered
 * rather than left stranded.
 */
export async function ensureServerIdentity(
	session: SshSession,
	apiKey: string
): Promise<ServerIdentity> {
	const existing = await readServerIdentity(session);
	const ip = await publicIp(session);

	const registered = await registerServer(apiKey, {
		ip,
		serverId: existing?.serverId,
		token: existing?.token
	});

	if (
		!existing ||
		existing.serverId !== registered.serverId ||
		existing.originHost !== registered.originHost ||
		existing.token !== registered.token
	) {
		await writeServerIdentity(session, registered);
		if (existing) {
			p.log.info(`${pc.cyan(session.target)} was re-registered with velastack.dev.`);
		}
	}

	// Idempotent and quiet when the origin site is already in place.
	await runServerScript(session, 'origin.sh');

	return registered;
}

/**
 * The server's public IPv4 address, as the internet sees it.
 *
 * Asked of velastack.dev from the server itself, so a machine behind an
 * ssh_config alias or a jump host still reports the address traffic actually
 * reaches. The route lookup is the fallback for a box that cannot reach out.
 */
async function publicIp(session: SshSession): Promise<string> {
	const result = await session.script(
		`api="$1"
if ip=$(curl -4fsS --max-time 10 "$api/v1/ip" 2>/dev/null); then
	printf '%s' "$ip"
else
	ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}'
fi`,
		{ args: [API_URL], check: false }
	);

	const raw = result.stdout.trim();
	let ip = raw;
	try {
		const parsed = JSON.parse(raw) as { ip?: unknown };
		if (typeof parsed.ip === 'string') ip = parsed.ip;
	} catch {
		// A bare address from the route lookup.
	}
	ip = ip.trim().replace(/^::ffff:/, '');

	if (!IPV4.test(ip)) {
		throw new Error(
			`Could not work out the public IPv4 address of ${session.target}.\n\n` +
				`The server needs to reach ${API_URL} (or have a default IPv4 route) for velastack.dev\n` +
				`to point its origin record at it.`
		);
	}
	return ip;
}
