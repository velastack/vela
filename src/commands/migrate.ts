import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { runCommand } from '../lib/run.ts';
import { up, runMigrateUp } from './migrate/up.ts';
import { down } from './migrate/down.ts';
import { create } from './migrate/create.ts';
import { collections } from './migrate/collections.ts';
import { historySync } from './migrate/history-sync.ts';

export const migrate = new Command('migrate')
	.description('manage database migrations')
	.configureHelp(helpConfig)
	.action(() => runCommand(runMigrateUp, 'Failed to run migrations.'))
	.addCommand(up)
	.addCommand(down)
	.addCommand(create)
	.addCommand(collections)
	.addCommand(historySync);
