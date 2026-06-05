import { Command } from 'commander';
import { exec, NonZeroExitError } from 'tinyexec';
import { detect, resolveCommand } from 'package-manager-detector';
import { helpConfig } from '../../lib/help.ts';
import { runCommand } from '../../lib/run.ts';
import { getWorkspace } from '../../lib/workspace.ts';
import { reportResult } from '../../lib/result-report.ts';

export const add = new Command('add')
	.description('add ui components')
	.argument('<components...>', 'the components to add')
	.configureHelp(helpConfig)
	.action((components: string[]) =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			const packageManager = (await detect({ cwd: workspaceRootDir }))?.name ?? 'npm';
			const resolved = resolveCommand(packageManager, 'execute', [
				'shadcn-svelte',
				'add',
				...components
			]);
			if (!resolved) {
				throw new Error(`Unable to resolve execute command for ${packageManager}`);
			}

			const args = [...resolved.args];
			if (packageManager === 'npm') args.unshift('--yes');

			try {
				await exec(resolved.command, args, {
					nodeOptions: { cwd: workspaceRootDir, stdio: 'inherit' },
					throwOnError: true
				});
			} catch (error) {
				const typed = error as NonZeroExitError;
				throw new Error(
					`Failed to execute '${resolved.command} ${args.join(' ')}': ${typed.message}`,
					{ cause: typed.output }
				);
			}

			reportResult({
				summary: `Added ${components.length} UI component(s).`,
				componentsAdded: components,
				nextSteps: [
					`Import a component with: import { Button } from '$lib/components/ui/button';`,
					'Tweak styling in src/lib/components/ui/<component>/*.svelte.',
					'Run `vela ui base <color>` to change the palette (slate, gray, zinc, stone, neutral).'
				]
			});
		}, 'Failed to add UI components.')
	);
