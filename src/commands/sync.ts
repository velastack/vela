import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { getWorkspace } from '../lib/workspace.ts';
import { withPocketbase } from '../lib/pocketbase.ts';
import { writePocketbaseTypes } from '../lib/pocketbase-types.ts';
import { migrateTsconfigTypesInclude, TSCONFIG_TYPES_MOVED } from '../lib/config-merge.ts';

export const sync = new Command('sync')
	.description('sync types from the database')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			const { processTypes } = await import('@velastack/pocketbase-codegen');

			await withPocketbase(workspaceRootDir, async (pb) => {
				await writePocketbaseTypes(workspaceRootDir, (dir) => processTypes(pb, dir));
			});
			if (migrateTsconfigTypesInclude(workspaceRootDir)) console.log(TSCONFIG_TYPES_MOVED);

			console.log('types synced');
		}, 'Failed to sync types.')
	);
