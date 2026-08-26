import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { envList } from './env/list.ts';
import { envSet } from './env/set.ts';
import { envUnset } from './env/unset.ts';
import { envImport } from './env/import.ts';

export const env = new Command('env')
	.description('manage production environment variables')
	.configureHelp(helpConfig)
	.addCommand(envList)
	.addCommand(envSet)
	.addCommand(envUnset)
	.addCommand(envImport);
