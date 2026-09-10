import process from 'node:process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import {
	addLockWaitOption,
	addTargetOptions,
	lockWaitArgs,
	withTarget
} from '../../lib/server-command.ts';
import { runServerScript } from '../../lib/remote.ts';
import { destroyDecision } from '../../lib/destroy-guard.ts';
import { reportEnvironmentDestroyed } from '../../lib/deploy-report.ts';

interface DestroyResult {
	purged: boolean;
	/** False when the server had nothing by that name; older scripts omit it. */
	existed?: boolean;
	/** Where a purge put the snapshot of the data it removed. */
	trash?: string;
}

export const deployment = addLockWaitOption(
	addTargetOptions(
		new Command('deployment')
			.description('remove a deployed environment from its server')
			.configureHelp(helpConfig),
		'production'
	)
)
	.option('--purge', 'also delete the database and uploaded files')
	.option('-y, --yes', 'skip the confirmation prompt')
	.option(
		'--confirm <app-name>',
		'confirm removing production, or a purge, by typing the app name — what a terminal would ask for'
	)
	.action((raw: unknown) =>
		runCommand(async () => {
			const options = raw as {
				purge?: boolean;
				yes?: boolean;
				confirm?: string;
				lockWait?: string;
			};
			await withTarget(
				raw,
				{
					remote: async (ctx) => {
						// Production is the one you cannot get back by redeploying, and a
						// purge takes the database with it. Neither is something `--yes`
						// alone may do: a workflow that passes `--yes` on every event must
						// still have typed the app's name to remove either.
						const decision = destroyDecision({
							appName: ctx.appName,
							envTag: ctx.envTag,
							purge: options.purge === true,
							yes: options.yes === true,
							confirm: options.confirm,
							interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY)
						});
						if (decision.kind === 'refuse') throw new Error(decision.message);
						if (decision.kind === 'prompt') {
							await confirm(ctx.appName, ctx.targetName, decision.byName);
						}

						const result = await runServerScript<DestroyResult>(ctx.session, 'destroy.sh', {
							args: [
								ctx.instance,
								...(options.purge ? ['--purge'] : []),
								...lockWaitArgs(options.lockWait)
							],
							stream: true
						});

						if (result?.existed === false) {
							p.log.info(
								`Nothing named ${pc.cyan(`${ctx.appName} (${ctx.targetName})`)} on ${ctx.server}; nothing to remove.`
							);
							return;
						}

						await reportEnvironmentDestroyed(ctx.workspaceRootDir, ctx.envTag);

						p.log.success(
							`Removed ${pc.cyan(`${ctx.appName} (${ctx.targetName})`)} from ${ctx.server}.` +
								(result?.purged
									? result.trash
										? `\n\nA snapshot of its data is at ${pc.cyan(result.trash)} on the server for two weeks.`
										: ''
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

async function confirm(appName: string, targetName: string, byName: boolean): Promise<void> {
	if (byName) {
		const answer = await p.text({
			message: `This removes ${pc.cyan(`${appName} (${targetName})`)}. Type the app name to confirm`,
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
