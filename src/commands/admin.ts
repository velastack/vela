import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { adminCreate } from './admin/create.ts';

export const admin = new Command('admin')
	.description('manage admin panel logins')
	.configureHelp(helpConfig)
	.addCommand(adminCreate);
