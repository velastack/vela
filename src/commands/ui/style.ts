import { Command } from 'commander';
import * as p from '@clack/prompts';
import { switchStyle, type SwitchStyleResult } from '@velastack/patterns';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';
import { STYLES } from '../../lib/ui-add.ts';
import { uiStyleReport } from '../../lib/ui-style.ts';

export const style = new Command('style')
	.description('switch the shadcn-svelte style, re-adding its components')
	.argument('<style>', `style to switch to (${STYLES.join(', ')})`)
	.option('-y, --yes', 'skip the confirmation prompt')
	.option('--no-font', "keep the current font instead of applying the style's")
	.configureHelp(helpConfig)
	.action((name: string, options: { yes?: boolean; font: boolean }) =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();

			// The registry is read before anything is written, so the prompt can
			// name exactly which components are about to be replaced; only once
			// that is confirmed does the task log take over the output.
			const spinner = p.spinner();
			spinner.start(`Reading the ${name} registry...`);
			let log: ReturnType<typeof p.taskLog> | undefined;
			let outcome: SwitchStyleResult;
			try {
				outcome = await switchStyle({
					root: workspaceRootDir,
					style: name,
					font: options.font,
					logger: { info: (message: string) => log?.message(message) },
					confirm: async (components) => {
						spinner.stop(`Read the ${name} registry`);
						if (components.length > 0) {
							p.log.info(
								`Re-adds ${components.length} component(s) from the ${name} registry; local edits to their files are lost:\n${components.map((c) => `- ${c}`).join('\n')}`
							);
						} else {
							p.log.info(
								`No installed component comes from the registry; only the config changes.`
							);
						}
						if (!options.yes) {
							const ok = await p.confirm({ message: `Switch to ${name}?`, initialValue: false });
							if (p.isCancel(ok) || !ok) return false;
						}
						log = p.taskLog({ title: `Switching to the ${name} style...` });
						return true;
					}
				});
			} catch (e) {
				spinner.stop(`Could not switch to ${name}`);
				log?.error('Could not switch style');
				throw e;
			}
			spinner.stop(`Read the ${name} registry`);

			if (outcome.status === 'unchanged') {
				p.log.info(`Already using the ${name} style.`);
				return;
			}
			if (outcome.status === 'cancelled') {
				p.cancel('Operation cancelled.');
				return;
			}
			log?.success('Style switched');
			reportResult(uiStyleReport(outcome));
		}, 'Failed to switch style.')
	);
