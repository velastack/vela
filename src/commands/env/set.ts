import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { isValidKey } from '../../lib/remote-env.ts';
import { applyLocalEnvChange, setLocalEnv } from '../../lib/local-env.ts';
import { addEnvTargetOptions, applyChange, withEnvScope } from '../../lib/env-command.ts';
import { isPublicKey, setInLayer, visibilityFor } from '../../lib/env-scopes.ts';

export const envSet = addEnvTargetOptions(
	new Command('set')
		.description('set an environment variable — the value is prompted for, never an argument')
		.argument('<key>', 'variable name')
		.option(
			'--public',
			'readable back with `vela env list` and `vela env get`; PUBLIC_* keys are public regardless'
		)
		.configureHelp(helpConfig)
).action((key: string, raw: { public?: boolean }) =>
	runCommand(async () => {
		if (!isValidKey(key)) throw new Error(`${key} is not a valid environment variable name.`);
		const asPublic = raw.public === true;

		await withEnvScope(
			raw,
			{
				local: async (ctx) => {
					// `.env` has no secret side: it is the developer's own file.
					const value = await promptValue(key, 'public');
					setLocalEnv(ctx.envFile, key, value);
					p.log.success(`${key} updated ${pc.dim('(local)')}`);
					await applyLocalEnvChange(ctx, [key]);
				},
				instance: async (ctx) => {
					const value = await promptValue(key, visibilityFor(key, asPublic));
					const outcome = await setInLayer(ctx.session, ctx.files, key, value, asPublic);
					report(key, outcome.visibility, outcome.moved, ctx.targetName);
					await applyChange(ctx.workspaceRootDir, ctx, [key]);
				},
				layer: async (ctx) => {
					const value = await promptValue(key, visibilityFor(key, asPublic));
					const outcome = await setInLayer(ctx.session, ctx.files, key, value, asPublic);
					report(key, outcome.visibility, outcome.moved, `${ctx.layer}, ${ctx.server}`);
					await applyChange(ctx.workspaceRootDir, ctx, [key]);
				}
			},
			{ label: 'env set', ask: true }
		);
	}, 'Failed to set the variable.')
);

function report(key: string, visibility: 'public' | 'secret', moved: boolean, where: string): void {
	const tag = visibility === 'public' ? ' (public)' : '';
	p.log.success(`${key} updated${tag} ${pc.dim(`(${where})`)}`);
	if (moved) {
		p.log.info(
			visibility === 'public'
				? `${key} was secret before; it is readable from now on.`
				: `${key} was public before; it is write-only from now on.`
		);
	}
}

/**
 * The value, typed in. A secret is taken without echo; a public value is
 * echoed, so the prompt itself says which kind is being set. Nothing is taken
 * from the command line, where it would land in shell history.
 */
async function promptValue(key: string, visibility: 'public' | 'secret'): Promise<string> {
	const message = `Value for ${pc.cyan(key)}${visibility === 'public' ? pc.dim(' (public)') : ''}`;
	const validate = (input: string | undefined) => (!input?.length ? 'Required' : undefined);
	const value =
		visibility === 'public'
			? await p.text({ message, validate })
			: await p.password({ message, validate });
	if (p.isCancel(value)) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
	if (visibility === 'secret' && isPublicKey(key)) {
		// Unreachable by construction — `visibilityFor` makes PUBLIC_* public —
		// but the invariant is worth stating where the prompt is.
		throw new Error(`${key} is a PUBLIC_ key and cannot be secret.`);
	}
	return value;
}
