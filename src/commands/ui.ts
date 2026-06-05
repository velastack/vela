import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { add } from './ui/add.ts';
import { base } from './ui/base.ts';

export const ui = new Command('ui')
	.description('generate ui components')
	.configureHelp(helpConfig)
	.addCommand(add)
	.addCommand(base);
