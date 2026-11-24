import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { adminCreate } from './admin/create.ts';

export const admin = new Command('admin')
	.description('manage logins for the /admin panel (PocketBase superusers, not app users)')
	.configureHelp(helpConfig)
	.addCommand(adminCreate);
