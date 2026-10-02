import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { up, runMigrateUp } from './migrate/up.ts';
import { down } from './migrate/down.ts';
import { create } from './migrate/create.ts';
import { collections } from './migrate/collections.ts';
import { historySync } from './migrate/history-sync.ts';
import { sveltekit3 } from './migrate/sveltekit-3.ts';

/**
 * Plain `vela migrate` runs pending PocketBase migrations, as it always has;
 * `vela migrate sveltekit-3` is the framework upgrade, a subcommand so the
 * plain form keeps its meaning.
 */
export const migrate = new Command('migrate')
	.description('manage database migrations (and `migrate sveltekit-3` to upgrade SvelteKit)')
	.configureHelp(helpConfig)
	.action(() => runCommand(runMigrateUp, 'Failed to run migrations.'))
	.addCommand(up)
	.addCommand(down)
	.addCommand(create)
	.addCommand(collections)
	.addCommand(historySync)
	.addCommand(sveltekit3);
