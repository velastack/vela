import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readApiKey } from './config.ts';
import { readProjectConfig } from './project-config.ts';
import type { ServerIdentity } from './remote.ts';
import { ensureServerIdentity } from './server-identity.ts';
import type { SshSession } from './ssh.ts';
import {
	destroyEnvironment,
	finishDeployment,
	startDeployment,
	type FinishDeploymentInput,
	type StartDeploymentInput,
	type StartDeploymentResult
} from './velastack-api.ts';

/**
 * Report a deploy to velastack.dev.
 *
 * Only a project that has been `vela link`ed has anywhere to report to, and only
 * when an API key is at hand — from `vela login` or `VELA_API_KEY` in CI. An
 * unlinked project deploys to its own server exactly as before and never
 * touches the network beyond SSH.
 *
 * Reporting is best-effort. velastack.dev being unreachable must not fail a
 * deploy the server has already accepted, so every call turns its error into a
 * warning; a caller that cannot proceed without the answer checks for null.
 */
export interface DeployReporter {
	/** Whether calls will be made at all. */
	readonly enabled: boolean;
	/**
	 * Register the server (or confirm it) so the deploy can claim a managed
	 * hostname. Null when reporting is off or registration failed; the deploy
	 * then goes ahead with the hostnames it has.
	 */
	identifyServer(session: SshSession): Promise<ServerIdentity | null>;
	start(input: StartDeploymentInput): Promise<StartDeploymentResult | null>;
	finish(input: FinishDeploymentInput): Promise<void>;
}

export function createDeployReporter(workspaceRootDir: string): DeployReporter {
	const link = readProjectConfig(workspaceRootDir);
	const apiKey = link ? readApiKey() : null;

	if (link && !apiKey) {
		p.log.warn(
			`This project is linked to ${pc.cyan(link.projectName)} on velastack.dev, but there is no\n` +
				`API key here, so this deploy will not be recorded. Run ${pc.cyan('vela login')}, or set\n` +
				`${pc.cyan('VELA_API_KEY')}.`
		);
	}

	let deploymentId: string | null = null;

	return {
		enabled: Boolean(link && apiKey),

		async identifyServer(session) {
			if (!link || !apiKey) return null;
			try {
				return await ensureServerIdentity(session, apiKey);
			} catch (err) {
				warn('register this server', err);
				return null;
			}
		},

		async start(input) {
			if (!link || !apiKey) return null;
			try {
				const result = await startDeployment(apiKey, link.projectId, input);
				deploymentId = result.deploymentId;
				return result;
			} catch (err) {
				warn('record this deploy', err);
				return null;
			}
		},

		async finish(input) {
			if (!link || !apiKey || !deploymentId) return;
			try {
				await finishDeployment(apiKey, link.projectId, deploymentId, input);
			} catch (err) {
				warn('update this deploy', err);
			}
		}
	};
}

/** After `destroy.sh` has removed an instance, retire its environment on velastack.dev. */
export async function reportEnvironmentDestroyed(
	workspaceRootDir: string,
	envTag: string
): Promise<void> {
	const link = readProjectConfig(workspaceRootDir);
	const apiKey = link ? readApiKey() : null;
	if (!link || !apiKey) return;
	try {
		await destroyEnvironment(apiKey, link.projectId, envTag);
	} catch (err) {
		warn('retire the environment', err);
	}
}

function warn(what: string, err: unknown): void {
	p.log.warn(
		`velastack.dev could not ${what}.\n${pc.dim(err instanceof Error ? err.message : String(err))}`
	);
}
