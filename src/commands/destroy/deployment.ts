import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { addTargetOptions, withTarget } from '../../lib/server-command.ts';
import { runServerScript } from '../../lib/remote.ts';
import { isProd } from '../../lib/instance.ts';

export const deployment = addTargetOptions(
	new Command('deployment')
		.description('remove a deployed environment from its server')
		.configureHelp(helpConfig),
	'production'
)
	.option('--purge', 'also delete the database and uploaded files')
	.option('-y, --yes', 'skip the confirmation prompt')
	.action((raw: unknown) =>
		runCommand(async () => {
			const options = raw as { purge?: boolean; yes?: boolean };
			await withTarget(
				raw,
				{
					remote: async (ctx) => {
						// Production is the one you cannot get back by redeploying, so it
						// always asks, and `--purge` on it asks for the name in full.
						if (!options.yes) {
							await confirm(ctx.appName, ctx.targetName, ctx.envTag, options.purge === true);
						}

						const result = await runServerScript<{ purged: boolean }>(ctx.session, 'destroy.sh', {
							args: [ctx.instance, ...(options.purge ? ['--purge'] : [])],
							stream: true
						});

						p.log.success(
							`Removed ${pc.cyan(`${ctx.appName} (${ctx.targetName})`)} from ${ctx.server}.` +
								(result?.purged
									? ''
									: `\n\nThe database and uploads are still in the instance's shared directory. Pass ${pc.cyan('--purge')} to delete them.`)
						);
					}
				},
				{
					label: 'destroy deployment',
					localHint: 'There is nothing deployed locally to remove.'
				}
			);
		}, 'Failed to remove the deployment.')
	);

async function confirm(
	appName: string,
	targetName: string,
	envTag: string,
	purge: boolean
): Promise<void> {
	if (isProd(envTag) || purge) {
		const answer = await p.text({
			message: `This removes ${pc.cyan(`${appName} (${targetName})`)}${purge ? ' and its database' : ''}. Type the app name to confirm`,
			validate: (value) => (value === appName ? undefined : `Type ${appName} to confirm`)
		});
		if (p.isCancel(answer)) {
			p.cancel('Operation cancelled.');
			process.exit(0);
		}
		return;
	}

	const ok = await p.confirm({
		message: `Remove ${appName} (${targetName})?`,
		initialValue: false
	});
	if (p.isCancel(ok) || !ok) {
		p.cancel('Operation cancelled.');
		process.exit(0);
	}
}
