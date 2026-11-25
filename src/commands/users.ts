import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { usersCreate } from './users/create.ts';

/**
 * App users: the accounts in the app's own auth collection, who sign in to the
 * app. Deliberately not under `admin`, which makes PocketBase superusers for
 * the `/admin` panel — the two are easy to confuse and do different things.
 */
export const users = new Command('users')
	.description('manage app users (the accounts that sign in to the app)')
	.configureHelp(helpConfig)
	.addCommand(usersCreate);
