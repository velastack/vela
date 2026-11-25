import { Command } from 'commander';
import pc from 'picocolors';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { getWorkspace } from '../lib/workspace.ts';
import { hasLocalDatabase, withPocketbase } from '../lib/pocketbase.ts';
import { writePocketbaseTypes } from '../lib/pocketbase-types.ts';
import { migrateTsconfigTypesInclude, TSCONFIG_TYPES_MOVED } from '../lib/config-merge.ts';

export const sync = new Command('sync')
	.description('sync types from the database')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(async () => {
			const { workspaceRootDir } = await getWorkspace();
			const { processTypes } = await import('@velastack/pocketbase-codegen');

			// The scaffold's `prepare` script runs this on every install. On a fresh
			// checkout (CI, a new clone) there is nothing to read types from yet,
			// which is not a failure worth a red line in an otherwise green run.
			if (!hasLocalDatabase(workspaceRootDir)) {
				console.log(pc.dim('No local database yet: skipping type sync. `vela dev` creates one.'));
				return;
			}

			await withPocketbase(workspaceRootDir, async (pb) => {
				await writePocketbaseTypes(workspaceRootDir, (dir) => processTypes(pb, dir));
			});
			if (migrateTsconfigTypesInclude(workspaceRootDir)) console.log(TSCONFIG_TYPES_MOVED);

			console.log('types synced');
		}, 'Failed to sync types.')
	);
