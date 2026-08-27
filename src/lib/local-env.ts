import fs from 'node:fs';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { removeEnvVar, upsertEnvVar } from './env.ts';
import { readLocalEnvFile, touchesSuperuser, type EnvRecord } from './remote-env.ts';
import { ensureSuperuser, getPocketbaseMetadata } from './pocketbase.ts';
import type { LocalContext } from './server-command.ts';

/** The project's `.env`, or an empty record when it has none yet. */
export function readLocalEnv(envFile: string): EnvRecord {
	if (!fs.existsSync(envFile)) return {};
	return readLocalEnvFile(envFile);
}

export function editLocalEnv(envFile: string, edit: (content: string) => string): void {
	const before = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
	const after = edit(before);
	if (after !== before) fs.writeFileSync(envFile, after);
}

export function setLocalEnv(envFile: string, key: string, value: string): void {
	editLocalEnv(envFile, (content) => upsertEnvVar(content, key, value));
}

export function unsetLocalEnv(envFile: string, key: string): void {
	editLocalEnv(envFile, (content) => removeEnvVar(content, key));
}

/**
 * The local counterpart of `applyEnvRestart`.
 *
 * Remotely, superuser credentials in the environment have to match a record in
 * the instance's database and only a deploy reconciles them. The same hazard
 * exists here, except the fix is local and immediate: `ensureSuperuser` upserts
 * the account so `.env` and `data/` cannot disagree.
 */
export async function applyLocalEnvChange(ctx: LocalContext, changed: string[]): Promise<void> {
	if (touchesSuperuser(changed)) {
		const env = readLocalEnv(ctx.envFile);
		const email = env.POCKETBASE_SUPERUSER_EMAIL;
		const password = env.POCKETBASE_SUPERUSER_PASSWORD;

		if (email && password) {
			// `ensureSuperuser` reads them from the environment of this process,
			// which was loaded before the file was edited.
			process.env.POCKETBASE_SUPERUSER_EMAIL = email;
			process.env.POCKETBASE_SUPERUSER_PASSWORD = password;
			await ensureSuperuser(ctx.workspaceRootDir);
			p.log.success('Local superuser updated to match');
		} else {
			p.log.warn(
				`The local database still has the old superuser.\n` +
					`Set both ${pc.cyan('POCKETBASE_SUPERUSER_EMAIL')} and ${pc.cyan('POCKETBASE_SUPERUSER_PASSWORD')} to reconcile it.`
			);
		}
	}

	if (getPocketbaseMetadata(ctx.workspaceRootDir)) {
		p.log.info(`Restart ${pc.cyan('vela dev')} to pick this up.`);
	}
}
