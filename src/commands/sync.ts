import path from 'node:path';
import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { getWorkspace } from '../lib/workspace.ts';
import { withPocketbase } from '../lib/pocketbase.ts';

export const sync = new Command('sync')
	.description('sync types from the database')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			const typesDir = path.join(workspaceRootDir, '.svelte-kit', 'types');

			const { processTypes } = await import('@velastack/pocketbase-codegen');

			await withPocketbase(workspaceRootDir, async (pb) => {
				await processTypes(pb, typesDir);
			});

			console.log('types synced');
		}, 'Failed to sync types.')
	);
