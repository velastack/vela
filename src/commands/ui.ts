import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { add } from './ui/add.ts';
import { base } from './ui/base.ts';
import { list } from './ui/list.ts';
import { style } from './ui/style.ts';
import { theme } from './ui/theme.ts';

export const ui = new Command('ui')
	.description('generate ui components')
	.configureHelp(helpConfig)
	.addCommand(add)
	.addCommand(list)
	.addCommand(style)
	.addCommand(base)
	.addCommand(theme);
