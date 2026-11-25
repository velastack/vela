import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addEnvTargetOptions, applyChange, withEnvScope } from '../../lib/env-command.ts';
import { applyLocalEnvChange } from '../../lib/local-env.ts';
import { isInteractive } from '../../lib/providers.ts';
import {
	EMAIL_ENV_KEYS,
	removeLocalEmailEnv,
	removeRemoteEmailEnv
} from '../../lib/email-settings.ts';

/**
 * The reverse of `vela enable email`, and like it not a pattern: it only
 * unsets the variables. `.env.example` keeps the names, which are harmless
 * empty and say what the project can be given.
 */
export const email = addEnvTargetOptions(
	new Command('email')
		.description(
			'turn outgoing email off: removes the PB_SMTP_* settings from .env, or from a deployed target with -t'
		)
		.option('-y, --yes', 'skip confirmation prompt')
		.configureHelp(helpConfig)
).action((raw: { yes?: boolean; target?: string }) =>
	runCommand(async () => {
		const target = raw.target?.trim() || 'local';
		if (!raw.yes) {
			if (!isInteractive()) {
				throw new Error(
					`There is no terminal to confirm on. Pass ${pc.cyan('--yes')} to remove the email settings from ${target}.`
				);
			}
			const ok = await p.confirm({
				message: `Remove ${EMAIL_ENV_KEYS.join(', ')} from ${target}? PocketBase stops sending email through SMTP.`,
				initialValue: false
			});
			if (p.isCancel(ok) || !ok) {
				p.cancel('Operation cancelled.');
				process.exit(0);
			}
		}

		await withEnvScope(
			{ ...raw, target },
			{
				local: async (ctx) => {
					const removed = removeLocalEmailEnv(ctx.workspaceRootDir);
					if (!report(removed, 'local')) return;
					await applyLocalEnvChange(ctx, removed);
				},
				instance: async (ctx) => {
					const removed = await removeRemoteEmailEnv(ctx.session, ctx.files);
					if (!report(removed, ctx.targetName)) return;
					await applyChange(ctx.workspaceRootDir, ctx, removed);
				},
				layer: async (ctx) => {
					const removed = await removeRemoteEmailEnv(ctx.session, ctx.files);
					if (!report(removed, `${ctx.layer}, ${ctx.server}`)) return;
					await applyChange(ctx.workspaceRootDir, ctx, removed);
				}
			},
			{ label: 'disable email' }
		);
	}, 'Failed to turn email off.')
);

function report(removed: string[], where: string): boolean {
	if (removed.length === 0) {
		p.log.info(`No email settings are set ${pc.dim(`(${where})`)} — nothing to remove.`);
		return false;
	}
	p.log.success(`Removed ${removed.join(', ')} ${pc.dim(`(${where})`)}`);
	return true;
}
