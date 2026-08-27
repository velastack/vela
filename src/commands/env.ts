import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { envList } from './env/list.ts';
import { envSet } from './env/set.ts';
import { envUnset } from './env/unset.ts';
import { envImport } from './env/import.ts';

export const env = new Command('env')
	.description('manage environment variables, locally or on a target')
	.configureHelp(helpConfig)
	.addCommand(envList)
	.addCommand(envSet)
	.addCommand(envUnset)
	.addCommand(envImport);
