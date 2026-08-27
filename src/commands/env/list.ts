import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addTargetOptions, withTarget } from '../../lib/server-command.ts';
import { readRemoteEnv } from '../../lib/remote-env.ts';
import { readLocalEnv } from '../../lib/local-env.ts';

export const envList = addTargetOptions(
	new Command('list').description('list environment variable names').configureHelp(helpConfig),
	'local'
).action((raw: unknown) =>
	runCommand(
		() =>
			withTarget(
				raw,
				{
					local: async (ctx) => {
						report(Object.keys(readLocalEnv(ctx.envFile)), `${ctx.appName}, local (.env)`);
					},
					remote: async (ctx) => {
						const env = await readRemoteEnv(ctx.session, ctx.instance);
						report(Object.keys(env), `${ctx.appName}, ${ctx.targetName}`);
					}
				},
				{ label: 'env list' }
			),
		'Failed to read the environment.'
	)
);

// Names only, never values — the same rule on both sides, so that piping the
// output of one into a screenshot or an issue is safe wherever it came from.
function report(keys: string[], where: string): void {
	if (keys.length === 0) {
		p.log.info(`No environment variables configured ${pc.dim(`(${where})`)}.`);
		return;
	}
	p.log.info(
		`Environment ${pc.dim(`(${where})`)}\n\n` +
			keys
				.sort()
				.map((key) => `  ${key}`)
				.join('\n')
	);
}
